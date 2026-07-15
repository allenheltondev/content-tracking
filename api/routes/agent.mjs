import { requireTenantId } from "../services/identity.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { createRuntimeSession } from "../services/agent-session.mjs";

// POST /agent/sessions — creates an "Ask your blog" agent session on the shared
// rsc-core AgentCore runtime, on the caller's behalf. This endpoint exists (vs.
// the browser calling rsc-core directly) so the assistant's behavior and its
// blog grounding are server-authoritative, not client-supplied.
//
// Flow:
//   1. Authorize (cognito-only) -> the verified sub.
//   2. Point the session at Booked's blog-search AgentCore Gateway (when
//      grounding is configured, BLOG_GATEWAY_URL set). No auth header is minted
//      here: the runtime authenticates to the gateway with the caller's own
//      Cognito token (the gateway's CUSTOM_JWT authorizer trusts the shared
//      pool), and a gateway interceptor forwards the verified sub to the tool.
//      Until the gateway host is allowlisted on the runtime (rsc-core#196) and
//      the runtime can present that token, BLOG_GATEWAY_URL stays unset and the
//      session is created WITHOUT mcpServers (an ungrounded assistant).
//   3. Create the session via the Core API, forwarding the caller's id token so
//      rsc-core records the same sub as the session owner.
//
// The browser still calls the Core API's /agent/connect directly to presign the
// wss:// socket; only session creation is proxied.

// The assistant's behavior lives here (server-authoritative) rather than being
// supplied by the client, so a caller can't repurpose the session's prompt.
const BLOG_ASSISTANT_PROMPT = `You are a research assistant for a content creator, helping them explore and reason about THEIR OWN published blog posts.

- When a blog search tool (e.g. search_blog) is available, use it to ground your answers in the creator's actual posts, and cite the posts you drew on.
- Base grounded claims only on what the tool returns. If the tool finds nothing relevant, say so plainly rather than inventing an answer.
- If no blog search tool is available, answer conversationally from context and make clear you are not drawing on their posts.
- Be concise and helpful. Format responses in Markdown when appropriate.`;

export function registerAgentRoutes(app) {
  app.post("/agent/sessions", async ({ event }) => {
    // Cognito-only: the blog assistant is a dashboard feature.
    requireTenantId(event);

    const authorization = getAuthorization(event);
    const session = await createRuntimeSession({
      authorization,
      systemPrompt: BLOG_ASSISTANT_PROMPT,
      title: "Ask your blog",
      mcpServers: buildBlogMcpServers(authorization),
    });

    return jsonResponse(201, { sessionId: session.sessionId, title: session.title });
  });
}

// Points the session at the blog-search AgentCore Gateway, or undefined when
// grounding is off (EnableBlogGrounding="false") so the session is an ungrounded
// assistant. The gateway URL is wired from the in-stack resource; the flag gates
// activation until the runtime side is ready (allowlist — rsc-core#196).
//
// Auth: we forward the caller's Cognito id token as the gateway's Authorization
// header (the runtime folds `authHeader` into the outbound headers, rsc-core
// #197; the gateway's CUSTOM_JWT authorizer validates it and its interceptor
// reads the sub). NOTE: this token is stored in the session config and lives
// only ~1h, so a session grounds for about an hour after creation — acceptable
// for now; the durable fix is per-connection token vending in the runtime
// (readysetcloud/rsc-core#199). Env is read per-call so the toggle takes effect
// without a cold start and tests can flip it.
function buildBlogMcpServers(authorization) {
  if (process.env.BLOG_GROUNDING_ENABLED !== "true") return undefined;
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
