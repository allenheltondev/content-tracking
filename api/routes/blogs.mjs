import { ulid } from "ulid";
import {
  createBlog,
  deleteBlog,
  findBlog,
  getBlog,
  getCrosspostStatus,
  listBlogsByTenant,
  listBlogsForCampaign,
  updateBlog,
} from "../domain/blog.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { decodeCursor, encodeCursor, parseLimit } from "../services/pagination.mjs";
import { startCrosspostExecution } from "../services/crosspost-invoker.mjs";
import { emptyResponse, jsonResponse } from "../services/http-handler.mjs";
import { BadRequestError, NotFoundError } from "../services/errors.mjs";
import { embedText } from "../services/embeddings.mjs";
import { queryBlogChunks } from "../services/blog-vectors.mjs";
import { answerBlogQuestion } from "../services/bedrock.mjs";
import {
  formatBlog,
  formatBlogAnswer,
  formatBlogSummary,
  formatCrosspostStatus,
  validateBlogCreate,
  validateBlogQuestion,
  validateBlogUpdate,
  validateCrosspostRequest,
} from "../validation/blog.mjs";

const SECONDS_PER_DAY = 24 * 60 * 60;

// Blog catalog CRUD. Every route resolves the tenant from the authorizer
// sub (requireTenantId) and passes it as the first argument to the domain,
// so reads/writes are confined to the caller's TENANT#{sub} partition.

export function registerBlogRoutes(app) {
  app.post("/blogs", withIdempotency(async ({ event }) => {
    const tenantId = requireTenantId(event);
    const fields = validateBlogCreate(parseBody(event));
    const item = await createBlog(tenantId, fields);
    return jsonResponse(201, formatBlog(item));
  }));

  // POST /blogs/ask — RAG Q&A over the tenant's blog catalog. Embeds the
  // question, retrieves the nearest chunks from the vector index (tenant-
  // scoped, optionally one post), and asks Bedrock to answer grounded in
  // them. Registered before /blogs/:blogId so the literal path wins. Nothing
  // is persisted; a retry just re-runs.
  app.post("/blogs/ask", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const { question, topK, blogId } = validateBlogQuestion(parseBody(event));

    const queryEmbedding = await embedText(question);
    const chunks = await queryBlogChunks({ tenantId, queryEmbedding, topK, blogId });

    // No vectors matched (empty catalog or nothing relevant): answer plainly
    // without spending a Bedrock call.
    if (chunks.length === 0) {
      return jsonResponse(200, formatBlogAnswer({
        answer: "I couldn't find anything in your blog catalog relevant to that question.",
        confidence: "low",
        citations: [],
      }));
    }

    const { answer, sources_used, confidence } = await answerBlogQuestion({ question, chunks });
    return jsonResponse(200, formatBlogAnswer({
      answer,
      confidence: confidence ?? "low",
      citations: resolveCitations(sources_used, chunks),
    }));
  });

  app.get("/blogs", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const qs = event.queryStringParameters ?? {};

    // ?campaignId=… returns just the blogs linked to that campaign (used by
    // the campaign detail view). It's a bounded set, so it isn't paginated.
    if (qs.campaignId) {
      const items = await listBlogsForCampaign(tenantId, qs.campaignId);
      return jsonResponse(200, {
        blogs: items.map(formatBlogSummary),
        nextStartKey: null,
      });
    }

    const limit = parseLimit(qs.limit);
    const exclusiveStartKey = decodeCursor(qs.startKey);
    const { items, lastEvaluatedKey } = await listBlogsByTenant(tenantId, { limit, exclusiveStartKey });
    return jsonResponse(200, {
      blogs: items.map(formatBlogSummary),
      nextStartKey: encodeCursor(lastEvaluatedKey),
    });
  });

  app.get("/blogs/:blogId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const blog = await getBlog(tenantId, params.blogId);
    return jsonResponse(200, formatBlog(blog));
  });

  app.patch("/blogs/:blogId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const fields = validateBlogUpdate(parseBody(event));
    if (Object.keys(fields).length === 0) {
      throw new BadRequestError("request body must contain at least one updatable field");
    }
    const updated = await updateBlog(tenantId, params.blogId, fields);
    return jsonResponse(200, formatBlog(updated));
  });

  app.delete("/blogs/:blogId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    await deleteBlog(tenantId, params.blogId);
    return emptyResponse(204);
  });

  // On-demand cross-post: validate, generate a runId, and start the durable
  // execution (async). Returns immediately; the client polls the status
  // route below. Wrapped in withIdempotency so a client retry with the same
  // Idempotency-Key returns the original runId instead of starting a second
  // run (the durable execution name + per-platform guard dedupe the rest).
  app.post("/blogs/:blogId/crosspost", withIdempotency(async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const blog = await findBlog(tenantId, params.blogId);
    if (!blog) {
      throw new NotFoundError("Blog", params.blogId);
    }

    const { platforms, staggerDays } = validateCrosspostRequest(parseBody(event));
    const runId = ulid();
    const withDelays = platforms.map((platform, i) => ({
      platform,
      delaySeconds: staggerDays ? i * staggerDays * SECONDS_PER_DAY : 0,
    }));

    await startCrosspostExecution({ tenantId, blogId: params.blogId, runId, platforms: withDelays });

    return jsonResponse(202, {
      run_id: runId,
      status: "in progress",
      platforms: withDelays.map((p) => ({ platform: p.platform, delay_seconds: p.delaySeconds })),
    });
  }));

  app.get("/blogs/:blogId/crosspost-status", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    // Pass ?run_id=… to correlate the poll to a specific (just-started) run
    // rather than whatever the latest persisted run happens to be.
    const runId = event.queryStringParameters?.run_id;
    const status = await getCrosspostStatus(tenantId, params.blogId, { runId });
    return jsonResponse(200, formatCrosspostStatus(status));
  });
}

// Maps the model's 1-based source_used numbers back to the posts they point
// at, deduped to one citation per blog (the same post can contribute several
// chunks). Out-of-range numbers are ignored so a stray index can't crash the
// response.
function resolveCitations(sourcesUsed, chunks) {
  const seen = new Set();
  const citations = [];
  for (const n of sourcesUsed ?? []) {
    const chunk = chunks[n - 1];
    if (!chunk || !chunk.blogId || seen.has(chunk.blogId)) continue;
    seen.add(chunk.blogId);
    citations.push({ blogId: chunk.blogId, title: chunk.title, slug: chunk.slug });
  }
  return citations;
}

function parseBody(event) {
  if (!event.body) {
    throw new BadRequestError("Missing request body");
  }
  try {
    return JSON.parse(event.body);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}
