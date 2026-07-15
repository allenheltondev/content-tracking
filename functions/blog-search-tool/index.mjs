import { embedText } from "../../api/services/embeddings.mjs";
import { queryContentChunks } from "../../api/services/content-vectors.mjs";
import { logger } from "../../api/services/logger.mjs";

// The `search_blog` tool, hosted as an AWS Lambda TARGET of an Amazon Bedrock
// AgentCore Gateway (see template.yaml `BlogGateway` / `BlogGatewayTarget`). The
// gateway is the MCP server; this Lambda never sees MCP — the gateway hands it
// the tool arguments as the event and turns the return value back into an MCP
// tool result.
//
// Tenant scoping: the gateway's Lambda contract does NOT pass the caller's
// identity, so a REQUEST interceptor (functions/blog-gateway-interceptor)
// decodes the gateway-validated Cognito JWT and injects the verified `sub` as
// `_callerSub` into the arguments before we're invoked. `tenantId === sub`
// (api/services/identity.mjs), so that value is the tenant we search. We refuse
// if it's absent rather than ever running an unscoped search.

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 20;

export const handler = async (event, context) => {
  const toolName = extractToolName(context);
  if (toolName && toolName !== "search_blog") {
    return toolError(`Unknown tool: ${toolName}`);
  }

  // Identity is injected by the interceptor from the verified JWT — never from
  // the model. Its absence means the interceptor didn't run: fail closed.
  const sub = typeof event?._callerSub === "string" ? event._callerSub.trim() : "";
  if (!sub) {
    logger.warn("blog-search-tool: missing _callerSub — refusing (interceptor not applied?)");
    return toolError("Caller identity is missing; cannot scope the search.");
  }

  const query = typeof event?.query === "string" ? event.query.trim() : "";
  if (!query) {
    return toolError("The 'query' argument is required.");
  }

  const topK = clampTopK(event?.topK);
  const blogId = typeof event?.blogId === "string" && event.blogId ? event.blogId : undefined;

  const queryEmbedding = await embedText(query);
  // type="blog" + tenantId=sub — identical scoping to POST /blogs/ask.
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

  return { count: results.length, results, sources: dedupeSources(chunks) };
};

// The gateway prefixes the visible tool name with the target name:
// `${targetName}___${toolName}`. Strip it back to the bare tool name.
function extractToolName(context) {
  const raw = context?.clientContext?.custom?.bedrockAgentCoreToolName;
  if (typeof raw !== "string") return undefined;
  const i = raw.indexOf("___");
  return i >= 0 ? raw.slice(i + 3) : raw;
}

// One citation entry per post, in order — mirrors the shape POST /blogs/ask
// returned (blog_id/title/slug).
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

function toolError(message) {
  return { error: message };
}
