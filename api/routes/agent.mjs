import { requireTenantId } from "../services/identity.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { createRuntimeSession } from "../services/agent-session.mjs";
import { signBlogGrant, BLOG_GRANT_HEADER } from "../services/blog-mcp-grant.mjs";

// POST /agent/sessions — creates an "Ask your blog" agent session on the shared
// rsc-core AgentCore runtime, on the caller's behalf. This endpoint exists (vs.
// the browser calling rsc-core directly) because the session must carry a
// Booked-minted grant the browser can't hold: we verify the caller here, mint
// the grant server-side, and proxy the create to the Core API.
//
// Flow:
//   1. Authorize (cognito-only) -> the verified sub, which IS the tenantId.
//   2. Mint a blog-search grant bound to that sub (services/blog-mcp-grant.mjs)
//      and attach it as the MCP server's auth header — but only when grounding
//      is configured (BLOG_MCP_URL set). Until Booked's blog-search MCP server
//      (#204) is deployed and its host allowlisted on the runtime
//      (readysetcloud/rsc-core#196), BLOG_MCP_URL is unset and the session is
//      created WITHOUT mcpServers, i.e. an ungrounded assistant. Grounding then
//      activates by setting BLOG_MCP_URL — no code change here.
//   3. Create the session via the Core API, forwarding the caller's id token so
//      rsc-core records the same sub as the session owner.
//
// The browser still calls the Core API's /agent/connect directly to presign the
// wss:// socket (no secret involved there); only session creation is proxied.

// The assistant's behavior lives here (server-authoritative) rather than being
// supplied by the client, so a caller can't repurpose the session's prompt.
const BLOG_ASSISTANT_PROMPT = `You are a research assistant for a content creator, helping them explore and reason about THEIR OWN published blog posts.

- When a blog search tool (e.g. search_blog) is available, use it to ground your answers in the creator's actual posts, and cite the posts you drew on.
- Base grounded claims only on what the tool returns. If the tool finds nothing relevant, say so plainly rather than inventing an answer.
- If no blog search tool is available, answer conversationally from context and make clear you are not drawing on their posts.
- Be concise and helpful. Format responses in Markdown when appropriate.`;

export function registerAgentRoutes(app) {
  app.post("/agent/sessions", async ({ event }) => {
    // Cognito-only: the blog assistant is a dashboard feature. This also gives
    // us the verified sub, which is the tenant the grant is scoped to.
    const sub = requireTenantId(event);

    const session = await createRuntimeSession({
      authorization: getAuthorization(event),
      systemPrompt: BLOG_ASSISTANT_PROMPT,
      title: "Ask your blog",
      mcpServers: buildBlogMcpServers(sub),
    });

    return jsonResponse(201, { sessionId: session.sessionId, title: session.title });
  });
}

// Builds the session's MCP server config carrying the blog-search grant, or
// undefined when grounding isn't configured yet (BLOG_MCP_URL unset) so the
// session is created as an ungrounded assistant. Env is read per-call so the
// grounding toggle takes effect without a cold start and so tests can flip it.
function buildBlogMcpServers(sub) {
  const url = process.env.BLOG_MCP_URL;
  if (!url) return undefined;

  const secret = process.env.BLOG_MCP_SIGNING_KEY;
  if (!secret) {
    throw new Error("BLOG_MCP_SIGNING_KEY env var is required when BLOG_MCP_URL is set.");
  }
  const version = Number(process.env.BLOG_MCP_KEY_VERSION || 1);
  const token = signBlogGrant({ sub, secret, version });

  return {
    blog: {
      transport: "streamable-http",
      url,
      authHeader: { name: BLOG_GRANT_HEADER, value: token },
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
