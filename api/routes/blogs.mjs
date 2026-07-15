import {
  deleteBlog,
  getBlog,
  listBlogsByTenant,
  listBlogsForCampaign,
  updateBlog,
} from "../domain/blog.mjs";
import {
  createContent,
  deleteContent,
  findContent,
  listContentByTenant,
  updateContent,
} from "../domain/content.mjs";
import { requirePublisherTenantId, requireTenantId } from "../services/identity.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { parseLimit } from "../services/pagination.mjs";
import { emptyResponse, jsonResponse } from "../services/http-handler.mjs";
import { BadRequestError } from "../services/errors.mjs";
import { embedText } from "../services/embeddings.mjs";
import { queryContentChunks } from "../services/content-vectors.mjs";
import { answerContentQuestion } from "../services/bedrock.mjs";
import {
  formatBlog,
  formatBlogAnswer,
  formatBlogSummary,
  validateBlogCreate,
  validateBlogQuestion,
  validateBlogUpdate,
} from "../validation/blog.mjs";

// Blog catalog CRUD. Every route resolves the tenant from the authorizer
// sub (requireTenantId) and passes it as the first argument to the domain,
// so reads/writes are confined to the caller's TENANT#{sub} partition.
//
// Content-model unification: the blog surface is now a thin facade over the
// unified Content entity (type="blog"). Writes are Content-first —
//   - POST /blogs        — creates a Content row (createContent).
//   - PATCH/DELETE       — edit/delete the Content row when present, falling
//                          back to a legacy Blog row for one not migrated yet.
// Reads are Content-authoritative with a legacy Blog fallback so un-migrated
// posts still resolve:
//   - GET /blogs/:blogId — Content first, Blog fallback (Content wins).
//   - GET /blogs         — merge of migrated Content + Blog-only rows,
//                          deduped Content-wins, newest-first.
// POST /blogs/ask is aliased onto the unified content-vectors index, scoped
// to type="blog" so it never pulls sponsored/other content.

export function registerBlogRoutes(app) {
  // Writes now target the unified Content entity (type="blog"), not a legacy
  // Blog row, so blog creation no longer forks the write path. Reads already
  // merge Content + un-migrated Blog rows, so this is transparent to GET /blogs
  // and the response shape is unchanged (asBlogRow aliases contentId→blogId).
  app.post("/blogs", withIdempotency(async ({ event }) => {
    // Publish endpoint: the dashboard OR a CI token (e.g. a publish hook in
    // the writing repo) may create a blog. Reads/edits/deletes below stay
    // cognito-only, so a leaked CI token can only ever add content.
    const tenantId = requirePublisherTenantId(event);
    const fields = validateBlogCreate(parseBody(event));
    const item = await createContent(tenantId, {
      ...fields,
      type: "blog",
      source: "owned",
      status: "published",
    });
    return jsonResponse(201, formatBlog(asBlogRow(item)));
  }));

  // POST /blogs/ask — RAG Q&A over the tenant's blog catalog. Now aliased onto
  // the unified content-vectors index: embeds the question, retrieves the
  // nearest chunks from the content vector index (tenant-scoped, type="blog"
  // so it never pulls sponsored/other content, optionally one post), and asks
  // Bedrock to answer grounded in them. The request/response contract is
  // unchanged (still accepts blog_id/top_k, still returns sources with
  // blog_id) — blog_id maps to contentId, and migrated blogs have
  // contentId === blogId. Registered before /blogs/:blogId so the literal path
  // wins. Nothing is persisted; a retry just re-runs.
  app.post("/blogs/ask", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const { question, topK, blogId } = validateBlogQuestion(parseBody(event));

    const queryEmbedding = await embedText(question);
    const chunks = await queryContentChunks({ tenantId, queryEmbedding, topK, contentId: blogId, type: "blog" });

    // No vectors matched (empty catalog or nothing relevant): answer plainly
    // without spending a Bedrock call.
    if (chunks.length === 0) {
      return jsonResponse(200, formatBlogAnswer({
        answer: "I couldn't find anything in your blog catalog relevant to that question.",
        confidence: "low",
        citations: [],
      }));
    }

    const { answer, sources_used, confidence } = await answerContentQuestion({ question, chunks });
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

    // Dual-read merge. Content (type="blog") is authoritative, but writes
    // still target Blog in this phase, so the list must surface BOTH migrated
    // Content rows AND any Blog-only rows that haven't been migrated. We fetch
    // every page of both sources (personal scale) and merge keyed by id; when
    // the same id exists in both, Content wins. This branch is therefore
    // unpaginated: a merge of two independently-cursored DynamoDB queries
    // can't be resumed from a single opaque cursor, and at personal scale the
    // full set is small — so we return nextStartKey: null (the ?campaignId=
    // branch above already does the same). An EXPLICIT ?limit= trims the
    // merged result; when absent we return the whole set rather than
    // parseLimit's default cap, since there's no cursor to fetch the rest.
    const limit = qs.limit !== undefined ? parseLimit(qs.limit) : undefined;

    const blogRows = await fetchAllBlogs(tenantId);
    const contentRows = await fetchAllContentBlogs(tenantId);

    const byId = new Map();
    for (const row of blogRows) {
      byId.set(row.blogId, row);
    }
    // Content wins on collision: overwrite any Blog row with the same id.
    for (const row of contentRows) {
      byId.set(row.contentId, asBlogRow(row));
    }

    const merged = [...byId.values()]
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    const trimmed = limit ? merged.slice(0, limit) : merged;

    return jsonResponse(200, {
      blogs: trimmed.map(formatBlogSummary),
      nextStartKey: null,
    });
  });

  app.get("/blogs/:blogId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    // Content authoritative: a migrated/edited Content row wins. Fall back to
    // the legacy Blog (getBlog throws NotFound when that's also absent), so
    // un-migrated and brand-new Blog-only posts still resolve.
    const content = await findContent(tenantId, params.blogId);
    if (content) {
      return jsonResponse(200, formatBlog(asBlogRow(content)));
    }
    const blog = await getBlog(tenantId, params.blogId);
    return jsonResponse(200, formatBlog(blog));
  });

  // Content-first: edit the unified row when it exists, else fall back to the
  // legacy Blog row for a post that hasn't been migrated yet.
  app.patch("/blogs/:blogId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const fields = validateBlogUpdate(parseBody(event));
    if (Object.keys(fields).length === 0) {
      throw new BadRequestError("request body must contain at least one updatable field");
    }
    const onContent = await findContent(tenantId, params.blogId);
    const updated = onContent
      ? await updateContent(tenantId, params.blogId, fields)
      : await updateBlog(tenantId, params.blogId, fields);
    return jsonResponse(200, formatBlog(onContent ? asBlogRow(updated) : updated));
  });

  app.delete("/blogs/:blogId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    // Content-first with a legacy fallback, mirroring DELETE /content/:id.
    if (await findContent(tenantId, params.blogId)) {
      await deleteContent(tenantId, params.blogId);
    } else {
      await deleteBlog(tenantId, params.blogId);
    }
    return emptyResponse(204);
  });

  // Cross-post is now the synchronous, content-native POST /content/:id/crosspost
  // (the durable /blogs crosspost pipeline has been retired).
}

// Normalizes a unified Content row into the shape the Blog formatters expect:
// they read row.blogId, so alias contentId onto blogId. Content's extra fields
// (type/source/status) are simply ignored by formatBlog/formatBlogSummary.
function asBlogRow(contentRow) {
  return { ...contentRow, blogId: contentRow.contentId };
}

// Consumes every page of the legacy Blog list for the tenant. Personal scale,
// so walking all pages is cheap; the merged GET /blogs read is unpaginated.
async function fetchAllBlogs(tenantId) {
  const items = [];
  let exclusiveStartKey;
  do {
    const page = await listBlogsByTenant(tenantId, { exclusiveStartKey });
    items.push(...page.items);
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

// Consumes every page of the unified Content list scoped to type="blog".
async function fetchAllContentBlogs(tenantId) {
  const items = [];
  let exclusiveStartKey;
  do {
    const page = await listContentByTenant(tenantId, { type: "blog", exclusiveStartKey });
    items.push(...page.items);
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

// Maps the model's 1-based source_used numbers back to the posts they point
// at, deduped to one citation per piece of content (the same post can
// contribute several chunks). Content chunks carry contentId; we emit blogId
// (= contentId) so formatBlogAnswer's response shape is unchanged. Out-of-range
// numbers are ignored so a stray index can't crash the response.
function resolveCitations(sourcesUsed, chunks) {
  const seen = new Set();
  const citations = [];
  for (const n of sourcesUsed ?? []) {
    const chunk = chunks[n - 1];
    if (!chunk || !chunk.contentId || seen.has(chunk.contentId)) continue;
    seen.add(chunk.contentId);
    citations.push({ blogId: chunk.contentId, title: chunk.title, slug: chunk.slug });
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
