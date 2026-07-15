import { embedText } from "../../api/services/embeddings.mjs";
import { queryContentChunks } from "../../api/services/content-vectors.mjs";
import { verifyBlogGrant, BLOG_GRANT_HEADER } from "../../api/services/blog-mcp-grant.mjs";
import { logger } from "../../api/services/logger.mjs";

// Booked's blog-search MCP server, behind a Function URL (AuthType NONE). The
// shared rsc-core AgentCore runtime connects here over MCP Streamable HTTP when
// an "Ask your blog" session references it in mcpServers (POST /agent/sessions).
// It exposes ONE tool, `search_blog`, that grounds the assistant in the
// creator's own published posts.
//
// Auth is NOT Cognito: the caller is the runtime, not the browser. Every request
// (including `initialize`) must carry the Booked-minted grant in the configured
// header (rsc-core#197). We verify it in-process, and the grant's `sub` — which
// IS the tenantId in this data model (api/services/identity.mjs) — scopes the
// vector search. So a leaked/guessed Function URL is useless without a valid,
// current grant, and a grant can only ever read ITS OWN tenant's blog.
//
// Transport: a stateless Streamable HTTP server. Each Lambda invocation is one
// JSON-RPC request/response; we return application/json (not SSE) and assign no
// session id, which the spec permits for a stateless tool server. GET (the
// optional server->client SSE stream) is unsupported -> 405.
//
// NOTE (verify on first deploy): the exact Streamable HTTP handshake against the
// live Strands MCP client can't be exercised without the deployed runtime.
// Confirm end-to-end (initialize -> tools/list -> tools/call) on first wiring,
// the same way rsc-core flags its AgentCore literals.

const SERVER_INFO = { name: "booked-blog-search", version: "1.0.0" };
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
// The grant key version this server accepts. Bump alongside the signing key to
// reject grants minted under a rotated-out key.
const ACCEPTED_KEY_VERSION = Number(process.env.BLOG_MCP_KEY_VERSION || 1);

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 20;

const SEARCH_BLOG_TOOL = {
  name: "search_blog",
  description:
    "Search the creator's OWN published blog posts for passages relevant to a query. " +
    "Returns matching excerpts plus each post's title/slug so you can cite sources. " +
    "Use this to ground any answer about their blog; do not answer from memory.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language search query." },
      topK: {
        type: "integer",
        description: `Max passages to return (1-${MAX_TOP_K}, default ${DEFAULT_TOP_K}).`,
        minimum: 1,
        maximum: MAX_TOP_K,
      },
      blogId: { type: "string", description: "Optional: restrict the search to a single post id." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method ?? "POST";
  if (method !== "POST") {
    // No standalone server->client SSE stream; the runtime only needs POST.
    return http(405, { error: "Only POST is supported" });
  }

  // Every request must carry a valid, current grant — including `initialize`.
  let sub;
  try {
    sub = authenticate(event);
  } catch (err) {
    logger.info("blog-mcp: unauthorized", { reason: err?.message });
    return http(401, { error: "Unauthorized" });
  }

  let message;
  try {
    message = JSON.parse(event.body ?? "");
  } catch {
    return http(200, jsonRpcError(null, -32700, "Parse error"));
  }

  // JSON-RPC batch (an array) or a single message.
  if (Array.isArray(message)) {
    const responses = [];
    for (const m of message) {
      const r = await dispatch(m, sub);
      if (r !== null) responses.push(r);
    }
    return responses.length === 0 ? accepted() : http(200, responses);
  }

  const response = await dispatch(message, sub);
  return response === null ? accepted() : http(200, response);
};

// Handles one JSON-RPC message. Returns a response object, or null for a
// notification (no id / notifications/* method) which gets a bare 202.
async function dispatch(msg, sub) {
  const { id, method, params } = msg ?? {};

  if (typeof method !== "string") {
    return jsonRpcError(id ?? null, -32600, "Invalid Request");
  }
  // Notifications carry no id and expect no response.
  if (method.startsWith("notifications/") || id === undefined || id === null) {
    return null;
  }

  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion:
            typeof params?.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: [SEARCH_BLOG_TOOL] });
      case "tools/call":
        return ok(id, await callTool(params, sub));
      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    logger.error("blog-mcp: method failed", { method, error: err?.message });
    return jsonRpcError(id, -32603, "Internal error");
  }
}

// Runs the one tool this server exposes. Tool-level failures come back as an
// isError result (per MCP) rather than a JSON-RPC error, so the model can see
// and react to them.
async function callTool(params, sub) {
  if (params?.name !== "search_blog") {
    return toolError(`Unknown tool: ${params?.name}`);
  }
  const args = params?.arguments ?? {};
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return toolError("The 'query' argument is required.");
  }
  const topK = clampTopK(args.topK);
  const blogId = typeof args.blogId === "string" && args.blogId ? args.blogId : undefined;

  const queryEmbedding = await embedText(query);
  // tenantId === the grant's sub. type="blog" so this never pulls sponsored or
  // other content — same index and scoping as POST /blogs/ask.
  const chunks = await queryContentChunks({
    tenantId: sub,
    queryEmbedding,
    topK,
    contentId: blogId,
    type: "blog",
  });

  const results = chunks.map((c) => ({
    blogId: c.contentId ?? null,
    title: c.title ?? null,
    slug: c.slug ?? null,
    distance: c.distance,
    text: c.text ?? "",
  }));

  const payload = { count: results.length, results, sources: dedupeSources(chunks) };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false };
}

// Verifies the grant from the configured header and returns the caller's sub.
// Throws on a missing/invalid/rotated-out grant.
function authenticate(event) {
  const headers = event?.headers ?? {};
  const key = Object.keys(headers).find((h) => h.toLowerCase() === BLOG_GRANT_HEADER);
  const token = key ? headers[key] : undefined;
  if (!token) throw new Error("Missing grant header");

  const secret = process.env.BLOG_MCP_SIGNING_KEY;
  if (!secret) throw new Error("BLOG_MCP_SIGNING_KEY is not configured");

  const { sub, ver } = verifyBlogGrant(token, secret);
  if (ver !== ACCEPTED_KEY_VERSION) {
    throw new Error(`Grant key version ${ver} not accepted (expected ${ACCEPTED_KEY_VERSION})`);
  }
  if (!sub) throw new Error("Grant missing sub");
  return sub;
}

// Collapse chunks to one entry per post, preserving order, for citations.
// Mirrors the shape POST /blogs/ask returned (blog_id/title/slug).
function dedupeSources(chunks) {
  const seen = new Set();
  const sources = [];
  for (const c of chunks) {
    const id = c.contentId ?? c.blogId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    sources.push({ blog_id: id, title: c.title ?? null, slug: c.slug ?? null });
  }
  return sources;
}

function clampTopK(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TOP_K;
  return Math.min(MAX_TOP_K, Math.max(1, Math.floor(n)));
}

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function http(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// A notification / empty batch gets a bare 202 with no body, per Streamable HTTP.
function accepted() {
  return { statusCode: 202, headers: { "content-type": "application/json" }, body: "" };
}
