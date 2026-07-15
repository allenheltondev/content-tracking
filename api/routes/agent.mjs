import { requestSession } from "@readysetcloud/agent/memory";
import { requireTenantId } from "../services/identity.mjs";
import { jsonResponse } from "../services/http-handler.mjs";

// POST /agent/sessions — creates an "Ask your blog" agent session on the shared
// rsc-core AgentCore runtime, on the caller's behalf. Server-authoritative (vs.
// the browser calling rsc-core directly) so the assistant's behavior and its
// blog grounding aren't client-supplied.
//
// We create the session by emitting a "Create Agent Session" event on the
// default bus via @readysetcloud/agent `requestSession` — rsc-core's stack owns
// the agent table and consumes the event. So Booked needs only events:PutEvents
// (already granted for Badge activity), no cross-stack table access and no HTTP
// hop. `requestSession` returns the sessionId immediately; the config row is
// written async, well before the runtime reads it (on the first message).
//
// Flow:
//   1. Authorize (cognito-only) -> the verified sub (the session owner).
//   2. Point the session at Booked's blog-search AgentCore Gateway (when
//      grounding is enabled). The caller's Cognito id token rides as the
//      gateway's Authorization header (rsc-core#197 folds `authHeader` into the
//      outbound headers); the gateway validates it and its interceptor forwards
//      the sub to the tool.
//   3. Emit the event; return the sessionId.
//
// The browser calls the Core API's /agent/connect directly to presign the wss://
// socket.

// The assistant's behavior lives here (server-authoritative) rather than being
// supplied by the client, so a caller can't repurpose the session's prompt.
const BLOG_ASSISTANT_PROMPT = `You are a research assistant for a content creator, helping them explore and reason about THEIR OWN published blog posts.

- When a blog search tool (e.g. search_blog) is available, use it to ground your answers in the creator's actual posts, and cite the posts you drew on.
- Base grounded claims only on what the tool returns. If the tool finds nothing relevant, say so plainly rather than inventing an answer.
- If no blog search tool is available, answer conversationally from context and make clear you are not drawing on their posts.
- Be concise and helpful. Format responses in Markdown when appropriate.`;

export function registerAgentRoutes(app) {
  app.post("/agent/sessions", async ({ event }) => {
    // Cognito-only: the blog assistant is a dashboard feature. The verified sub
    // becomes the session owner (the runtime enforces it on connect).
    const sub = requireTenantId(event);

    const { sessionId } = await requestSession({
      userId: sub,
      systemPrompt: BLOG_ASSISTANT_PROMPT,
      title: "Ask your blog",
      mcpServers: buildBlogMcpServers(getAuthorization(event)),
    });

    return jsonResponse(201, { sessionId });
  });
}

// Points the session at the blog-search AgentCore Gateway. The gateway URL is
// wired from the in-stack resource (always set), so every session is grounded.
//
// Auth: we forward the caller's Cognito id token as the gateway's Authorization
// header (the runtime folds `authHeader` into the outbound headers, rsc-core
// #197; the gateway's CUSTOM_JWT authorizer validates it and its interceptor
// reads the sub). NOTE: this token is stored in the session config and lives
// only ~1h, so a session grounds for about an hour after creation — acceptable
// for now; the durable fix is per-connection token vending in the runtime
// (readysetcloud/rsc-core#199). Returns undefined only if the URL/token are
// somehow absent, degrading to an ungrounded session rather than erroring.
function buildBlogMcpServers(authorization) {
  const url = process.env.BLOG_GATEWAY_URL;
  if (!url || !authorization) return undefined;
  return {
    blog: {
      transport: "streamable-http",
      url,
      authHeader: { name: "Authorization", value: authorization },
    },
  };
}

// The caller's Authorization header, forwarded verbatim to the Core API (whose
// JWT authorizer re-verifies it). REST proxy header casing varies, so match
// case-insensitively.
function getAuthorization(event) {
  const headers = event?.headers ?? {};
  const key = Object.keys(headers).find((h) => h.toLowerCase() === "authorization");
  return key ? headers[key] : undefined;
}
