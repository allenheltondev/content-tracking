import { jest } from "@jest/globals";
import { NotFoundError } from "../services/errors.mjs";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

jest.unstable_mockModule("../domain/blog.mjs", () => ({
  getBlog: jest.fn(),
  listBlogsByTenant: jest.fn(),
  listBlogsForCampaign: jest.fn(),
  updateBlog: jest.fn(),
  deleteBlog: jest.fn(),
}));
// Reads dual-read Content + legacy Blog; writes are content-first.
jest.unstable_mockModule("../domain/content.mjs", () => ({
  createContent: jest.fn(),
  updateContent: jest.fn(),
  deleteContent: jest.fn(),
  findContent: jest.fn(),
  listContentByTenant: jest.fn(),
}));
// Pass-through so the POST handler runs without the Powertools idempotency
// machinery (which would otherwise need the persistence layer).
jest.unstable_mockModule("../services/idempotency.mjs", () => ({
  withIdempotency: (fn) => fn,
}));
// RAG Q&A collaborators (POST /blogs/ask): embed the question, retrieve
// chunks, answer with Bedrock. Mocked so the route is exercised in isolation.
jest.unstable_mockModule("../services/embeddings.mjs", () => ({
  embedText: jest.fn(),
}));
jest.unstable_mockModule("../services/content-vectors.mjs", () => ({
  queryContentChunks: jest.fn(),
}));
jest.unstable_mockModule("../services/bedrock/qa.mjs", () => ({
  answerContentQuestion: jest.fn(),
}));

const { getBlog, listBlogsByTenant, listBlogsForCampaign, updateBlog, deleteBlog } = await import("../domain/blog.mjs");
const { createContent, updateContent, deleteContent, findContent, listContentByTenant } = await import("../domain/content.mjs");
const { embedText } = await import("../services/embeddings.mjs");
const { queryContentChunks } = await import("../services/content-vectors.mjs");
const { answerContentQuestion } = await import("../services/bedrock/qa.mjs");
const { registerBlogRoutes } = await import("../routes/blogs.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    get: (path, handler) => { routes[`GET ${path}`] = handler; },
    post: (path, handler) => { routes[`POST ${path}`] = handler; },
    patch: (path, handler) => { routes[`PATCH ${path}`] = handler; },
    delete: (path, handler) => { routes[`DELETE ${path}`] = handler; },
    put: (path, handler) => { routes[`PUT ${path}`] = handler; },
  };
  registerBlogRoutes(app);
  return routes;
}

const routes = buildRouteTable();
const SUB = "user-1";

function ctx({ body, params, query } = {}) {
  return {
    event: {
      body: body === undefined ? undefined : JSON.stringify(body),
      queryStringParameters: query,
      requestContext: { authorizer: { authSource: "cognito", sub: SUB } },
    },
    params,
  };
}

const sampleRow = {
  blogId: "B1",
  title: "Hi",
  slug: "hi",
  contentMarkdown: "# body",
  links: { url: "https://x/blog/hi" },
  createdAt: "t0",
  updatedAt: "t1",
};

beforeEach(() => {
  jest.clearAllMocks();
  // Dual-read defaults: empty Content so tests that only exercise the legacy
  // Blog paths don't need to set these up. Merge/Content-first tests override.
  findContent.mockResolvedValue(null);
  listContentByTenant.mockResolvedValue({ items: [], lastEvaluatedKey: undefined });
  listBlogsByTenant.mockResolvedValue({ items: [], lastEvaluatedKey: undefined });
});

describe("POST /blogs", () => {
  test("creates a unified Content row (type=blog), not a legacy Blog row", async () => {
    createContent.mockResolvedValue({ ...sampleRow, contentId: "B1" });
    const res = await routes["POST /blogs"](ctx({ body: { title: "Hi", slug: "hi", content_markdown: "# body" } }));

    expect(res.statusCode).toBe(201);
    expect(createContent).toHaveBeenCalledWith(SUB, expect.objectContaining({
      title: "Hi",
      slug: "hi",
      contentMarkdown: "# body",
      type: "blog",
      source: "owned",
      status: "published",
    }));
    // Response shape unchanged: contentId is aliased back to blog_id.
    expect(JSON.parse(res.body).blog_id).toBe("B1");
  });

  test("rejects an invalid payload before touching the domain", async () => {
    await expect(routes["POST /blogs"](ctx({ body: { slug: "hi" } }))).rejects.toThrow(/title is required/);
    expect(createContent).not.toHaveBeenCalled();
  });
});

describe("GET /blogs", () => {
  test("lists the tenant's blogs as summaries (no content_markdown)", async () => {
    listBlogsByTenant.mockResolvedValue({ items: [sampleRow], lastEvaluatedKey: undefined });
    const res = await routes["GET /blogs"](ctx({ query: { limit: "10" } }));

    expect(listBlogsByTenant).toHaveBeenCalledWith(SUB, expect.objectContaining({}));
    const body = JSON.parse(res.body);
    expect(body.blogs).toHaveLength(1);
    expect(body.blogs[0]).not.toHaveProperty("content_markdown");
    expect(body.blogs[0].blog_id).toBe("B1");
    // The merged list can't use a single DynamoDB cursor, so it's unpaginated.
    expect(body.nextStartKey).toBeNull();
  });

  test("merges Blog-only + Content rows, deduped Content-wins, newest first", async () => {
    // B-only: a legacy Blog with no Content row. SHARED: present in both
    // (Content must win). C-only: a migrated Content blog with no Blog row.
    listBlogsByTenant.mockResolvedValue({
      items: [
        { blogId: "B-only", title: "Blog Only", slug: "blog-only", createdAt: "t1" },
        { blogId: "SHARED", title: "Stale Blog Title", slug: "stale", createdAt: "t2" },
      ],
      lastEvaluatedKey: undefined,
    });
    listContentByTenant.mockResolvedValue({
      items: [
        { contentId: "SHARED", type: "blog", source: "owned", status: "published", title: "Fresh Content Title", slug: "fresh", createdAt: "t2" },
        { contentId: "C-only", type: "blog", source: "owned", status: "published", title: "Content Only", slug: "content-only", createdAt: "t3" },
      ],
      lastEvaluatedKey: undefined,
    });

    const res = await routes["GET /blogs"](ctx({ query: {} }));

    // Both sources are queried (Content scoped to type=blog).
    expect(listBlogsByTenant).toHaveBeenCalledWith(SUB, expect.objectContaining({}));
    expect(listContentByTenant).toHaveBeenCalledWith(SUB, expect.objectContaining({ type: "blog" }));

    const body = JSON.parse(res.body);
    expect(body.nextStartKey).toBeNull();
    // Deduped: SHARED appears once. Newest-first by createdAt: C-only(t3),
    // SHARED(t2), B-only(t1).
    expect(body.blogs.map((b) => b.blog_id)).toEqual(["C-only", "SHARED", "B-only"]);
    // Content wins on the shared id: the Content title/slug, not the Blog's.
    const shared = body.blogs.find((b) => b.blog_id === "SHARED");
    expect(shared.title).toBe("Fresh Content Title");
    expect(shared.slug).toBe("fresh");
  });

  test("?campaignId returns the campaign's blogs (unpaginated)", async () => {
    listBlogsForCampaign.mockResolvedValue([sampleRow]);
    const res = await routes["GET /blogs"](ctx({ query: { campaignId: "camp-1" } }));

    expect(listBlogsForCampaign).toHaveBeenCalledWith(SUB, "camp-1");
    expect(listBlogsByTenant).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.blogs[0].blog_id).toBe("B1");
    expect(body.nextStartKey).toBeNull();
  });
});

describe("GET /blogs/:blogId", () => {
  test("Content-first: serves the unified Content row and skips getBlog", async () => {
    findContent.mockResolvedValue({
      contentId: "B1",
      type: "blog",
      source: "owned",
      status: "published",
      title: "From Content",
      slug: "from-content",
      contentMarkdown: "# content body",
      createdAt: "t0",
      updatedAt: "t1",
    });

    const res = await routes["GET /blogs/:blogId"](ctx({ params: { blogId: "B1" } }));

    expect(findContent).toHaveBeenCalledWith(SUB, "B1");
    expect(getBlog).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.blog_id).toBe("B1"); // contentId aliased onto blog_id
    expect(body.title).toBe("From Content");
    expect(body.content_markdown).toBe("# content body");
  });

  test("falls back to getBlog when no Content row exists", async () => {
    findContent.mockResolvedValue(null);
    getBlog.mockResolvedValue(sampleRow);

    const res = await routes["GET /blogs/:blogId"](ctx({ params: { blogId: "B1" } }));

    expect(findContent).toHaveBeenCalledWith(SUB, "B1");
    expect(getBlog).toHaveBeenCalledWith(SUB, "B1");
    expect(JSON.parse(res.body).content_markdown).toBe("# body");
  });

  test("404s when both Content and Blog are absent", async () => {
    findContent.mockResolvedValue(null);
    getBlog.mockRejectedValue(new NotFoundError("Blog", "X"));

    await expect(routes["GET /blogs/:blogId"](ctx({ params: { blogId: "X" } }))).rejects.toThrow(/Blog X not found/);
  });
});

describe("PATCH /blogs/:blogId", () => {
  test("updates with validated fields", async () => {
    updateBlog.mockResolvedValue({ ...sampleRow, title: "New" });
    const res = await routes["PATCH /blogs/:blogId"](ctx({ params: { blogId: "B1" }, body: { title: "New" } }));

    expect(updateBlog).toHaveBeenCalledWith(SUB, "B1", { title: "New" });
    expect(JSON.parse(res.body).title).toBe("New");
  });

  test("edits the unified Content row when one exists (content-first)", async () => {
    findContent.mockResolvedValue({ contentId: "B1", title: "Old" });
    updateContent.mockResolvedValue({ ...sampleRow, contentId: "B1", title: "New" });
    const res = await routes["PATCH /blogs/:blogId"](ctx({ params: { blogId: "B1" }, body: { title: "New" } }));

    expect(updateContent).toHaveBeenCalledWith(SUB, "B1", { title: "New" });
    expect(updateBlog).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).title).toBe("New");
  });

  test("rejects an empty update body", async () => {
    await expect(routes["PATCH /blogs/:blogId"](ctx({ params: { blogId: "B1" }, body: {} }))).rejects.toThrow(/at least one updatable field/);
    expect(updateBlog).not.toHaveBeenCalled();
    expect(updateContent).not.toHaveBeenCalled();
  });
});

describe("DELETE /blogs/:blogId", () => {
  test("deletes a legacy Blog row (fallback) and returns 204", async () => {
    deleteBlog.mockResolvedValue({ deleted: 1 });
    const res = await routes["DELETE /blogs/:blogId"](ctx({ params: { blogId: "B1" } }));

    expect(deleteBlog).toHaveBeenCalledWith(SUB, "B1");
    expect(deleteContent).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(204);
  });

  test("deletes the unified Content row when one exists (content-first)", async () => {
    findContent.mockResolvedValue({ contentId: "B1" });
    deleteContent.mockResolvedValue({ deleted: 1 });
    const res = await routes["DELETE /blogs/:blogId"](ctx({ params: { blogId: "B1" } }));

    expect(deleteContent).toHaveBeenCalledWith(SUB, "B1");
    expect(deleteBlog).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(204);
  });
});

describe("POST /blogs/ask", () => {
  const ask = () => routes["POST /blogs/ask"];

  test("embeds the question, retrieves content chunks, and answers grounded with citations", async () => {
    embedText.mockResolvedValue([0.1, 0.2, 0.3]);
    queryContentChunks.mockResolvedValue([
      { contentId: "B1", type: "blog", title: "Faster Builds", slug: "faster-builds", text: "cut build time", distance: 0.1 },
      { contentId: "B2", type: "blog", title: "Caching", slug: "caching", text: "cache layers", distance: 0.3 },
    ]);
    answerContentQuestion.mockResolvedValue({
      answer: "You wrote about cutting build times.",
      sources_used: [1],
      confidence: "high",
    });

    const res = await ask()(ctx({ body: { question: "How do I speed up builds?" } }));

    expect(res.statusCode).toBe(200);
    expect(embedText).toHaveBeenCalledWith("How do I speed up builds?");
    // Tenant-scoped retrieval over the unified content index, scoped to
    // type="blog" with the validated default top_k. blogId maps to contentId.
    expect(queryContentChunks).toHaveBeenCalledWith({
      tenantId: SUB,
      queryEmbedding: [0.1, 0.2, 0.3],
      topK: 8,
      contentId: undefined,
      type: "blog",
    });
    const body = JSON.parse(res.body);
    expect(body.answer).toMatch(/build times/);
    expect(body.confidence).toBe("high");
    // Only the cited source is surfaced; contentId is mapped onto blog_id.
    expect(body.sources).toEqual([{ blog_id: "B1", title: "Faster Builds", slug: "faster-builds" }]);
  });

  test("passes top_k and blog_id (as contentId) through to retrieval", async () => {
    embedText.mockResolvedValue([0.5]);
    queryContentChunks.mockResolvedValue([{ contentId: "B9", type: "blog", title: "T", slug: "t", text: "x" }]);
    answerContentQuestion.mockResolvedValue({ answer: "a", sources_used: [], confidence: "low" });

    await ask()(ctx({ body: { question: "what did I say?", top_k: 3, blog_id: "B9" } }));

    expect(queryContentChunks).toHaveBeenCalledWith({
      tenantId: SUB,
      queryEmbedding: [0.5],
      topK: 3,
      contentId: "B9",
      type: "blog",
    });
  });

  test("short-circuits without calling Bedrock when nothing matches", async () => {
    embedText.mockResolvedValue([0.1]);
    queryContentChunks.mockResolvedValue([]);

    const res = await ask()(ctx({ body: { question: "obscure topic" } }));

    expect(res.statusCode).toBe(200);
    expect(answerContentQuestion).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.confidence).toBe("low");
    expect(body.sources).toEqual([]);
  });

  test("ignores out-of-range and duplicate source numbers from the model", async () => {
    embedText.mockResolvedValue([0.1]);
    queryContentChunks.mockResolvedValue([
      { contentId: "B1", type: "blog", title: "One", slug: "one", text: "a" },
      { contentId: "B1", type: "blog", title: "One", slug: "one", text: "b" },
    ]);
    answerContentQuestion.mockResolvedValue({ answer: "a", sources_used: [1, 2, 99], confidence: "medium" });

    const res = await ask()(ctx({ body: { question: "q" } }));
    // Both chunks are content B1, and 99 is out of range → one citation.
    expect(JSON.parse(res.body).sources).toEqual([{ blog_id: "B1", title: "One", slug: "one" }]);
  });

  test("rejects an empty question before embedding", async () => {
    await expect(ask()(ctx({ body: { question: "   " } }))).rejects.toThrow(/question must be a non-empty string/);
    expect(embedText).not.toHaveBeenCalled();
  });
});

describe("auth", () => {
  test("rejects callers without dashboard sign-in", async () => {
    const noAuth = { event: { queryStringParameters: {} }, params: {} };
    await expect(routes["GET /blogs"](noAuth)).rejects.toThrow(/dashboard sign-in/);
  });
});
