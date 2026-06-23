import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

jest.unstable_mockModule("../domain/blog.mjs", () => ({
  createBlog: jest.fn(),
  getBlog: jest.fn(),
  findBlog: jest.fn(),
  getCrosspostStatus: jest.fn(),
  listBlogsByTenant: jest.fn(),
  listBlogsForCampaign: jest.fn(),
  updateBlog: jest.fn(),
  deleteBlog: jest.fn(),
}));
// Pass-through so the POST handler runs without the Powertools idempotency
// machinery (which would otherwise need the persistence layer).
jest.unstable_mockModule("../services/idempotency.mjs", () => ({
  withIdempotency: (fn) => fn,
}));
jest.unstable_mockModule("../services/crosspost-invoker.mjs", () => ({
  startCrosspostExecution: jest.fn(),
}));

const { createBlog, getBlog, findBlog, getCrosspostStatus, listBlogsByTenant, listBlogsForCampaign, updateBlog, deleteBlog } = await import("../domain/blog.mjs");
const { startCrosspostExecution } = await import("../services/crosspost-invoker.mjs");
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
});

describe("POST /blogs", () => {
  test("creates a blog scoped to the signed-in user", async () => {
    createBlog.mockResolvedValue(sampleRow);
    const res = await routes["POST /blogs"](ctx({ body: { title: "Hi", slug: "hi", content_markdown: "# body" } }));

    expect(res.statusCode).toBe(201);
    expect(createBlog).toHaveBeenCalledWith(SUB, {
      title: "Hi",
      slug: "hi",
      contentMarkdown: "# body",
    });
    expect(JSON.parse(res.body).blog_id).toBe("B1");
  });

  test("rejects an invalid payload before touching the domain", async () => {
    await expect(routes["POST /blogs"](ctx({ body: { slug: "hi" } }))).rejects.toThrow(/title is required/);
    expect(createBlog).not.toHaveBeenCalled();
  });
});

describe("GET /blogs", () => {
  test("lists the tenant's blogs as summaries (no content_markdown)", async () => {
    listBlogsByTenant.mockResolvedValue({ items: [sampleRow], lastEvaluatedKey: undefined });
    const res = await routes["GET /blogs"](ctx({ query: { limit: "10" } }));

    expect(listBlogsByTenant).toHaveBeenCalledWith(SUB, expect.objectContaining({ limit: 10 }));
    const body = JSON.parse(res.body);
    expect(body.blogs).toHaveLength(1);
    expect(body.blogs[0]).not.toHaveProperty("content_markdown");
    expect(body.blogs[0].blog_id).toBe("B1");
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
  test("returns the full blog including content_markdown", async () => {
    getBlog.mockResolvedValue(sampleRow);
    const res = await routes["GET /blogs/:blogId"](ctx({ params: { blogId: "B1" } }));

    expect(getBlog).toHaveBeenCalledWith(SUB, "B1");
    expect(JSON.parse(res.body).content_markdown).toBe("# body");
  });
});

describe("PATCH /blogs/:blogId", () => {
  test("updates with validated fields", async () => {
    updateBlog.mockResolvedValue({ ...sampleRow, title: "New" });
    const res = await routes["PATCH /blogs/:blogId"](ctx({ params: { blogId: "B1" }, body: { title: "New" } }));

    expect(updateBlog).toHaveBeenCalledWith(SUB, "B1", { title: "New" });
    expect(JSON.parse(res.body).title).toBe("New");
  });

  test("rejects an empty update body", async () => {
    await expect(routes["PATCH /blogs/:blogId"](ctx({ params: { blogId: "B1" }, body: {} }))).rejects.toThrow(/at least one updatable field/);
    expect(updateBlog).not.toHaveBeenCalled();
  });
});

describe("DELETE /blogs/:blogId", () => {
  test("deletes and returns 204", async () => {
    deleteBlog.mockResolvedValue({ deleted: 1 });
    const res = await routes["DELETE /blogs/:blogId"](ctx({ params: { blogId: "B1" } }));

    expect(deleteBlog).toHaveBeenCalledWith(SUB, "B1");
    expect(res.statusCode).toBe(204);
  });
});

describe("POST /blogs/:blogId/crosspost", () => {
  test("starts a durable execution with immediate (0s) delays", async () => {
    findBlog.mockResolvedValue(sampleRow);
    startCrosspostExecution.mockResolvedValue({ started: true });

    const res = await routes["POST /blogs/:blogId/crosspost"](ctx({ params: { blogId: "B1" }, body: { platforms: ["dev", "medium"] } }));

    expect(res.statusCode).toBe(202);
    const arg = startCrosspostExecution.mock.calls[0][0];
    expect(arg).toMatchObject({ tenantId: SUB, blogId: "B1" });
    expect(arg.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(arg.platforms).toEqual([{ platform: "dev", delaySeconds: 0 }, { platform: "medium", delaySeconds: 0 }]);
    expect(JSON.parse(res.body).run_id).toBe(arg.runId);
  });

  test("staggers delays by stagger_days", async () => {
    findBlog.mockResolvedValue(sampleRow);
    startCrosspostExecution.mockResolvedValue({ started: true });

    await routes["POST /blogs/:blogId/crosspost"](ctx({ params: { blogId: "B1" }, body: { platforms: ["dev", "medium", "hashnode"], stagger_days: 2 } }));

    const arg = startCrosspostExecution.mock.calls[0][0];
    expect(arg.platforms.map((p) => p.delaySeconds)).toEqual([0, 172800, 345600]); // 0, 2d, 4d
  });

  test("404s when the blog does not exist (no execution started)", async () => {
    findBlog.mockResolvedValue(null);
    await expect(routes["POST /blogs/:blogId/crosspost"](ctx({ params: { blogId: "X" }, body: { platforms: ["dev"] } }))).rejects.toThrow(/Blog X not found/);
    expect(startCrosspostExecution).not.toHaveBeenCalled();
  });

  test("rejects an invalid request before starting", async () => {
    findBlog.mockResolvedValue(sampleRow);
    await expect(routes["POST /blogs/:blogId/crosspost"](ctx({ params: { blogId: "B1" }, body: { platforms: [] } }))).rejects.toThrow(/non-empty array/);
    expect(startCrosspostExecution).not.toHaveBeenCalled();
  });
});

describe("GET /blogs/:blogId/crosspost-status", () => {
  test("returns the formatted run + per-platform status", async () => {
    getCrosspostStatus.mockResolvedValue({
      run: { runId: "R1", status: "in progress", platforms: ["dev"], startedAt: "t0" },
      copies: [{ platform: "dev", status: "succeeded", url: "https://dev/x", id: 5 }],
    });

    const res = await routes["GET /blogs/:blogId/crosspost-status"](ctx({ params: { blogId: "B1" } }));

    expect(getCrosspostStatus).toHaveBeenCalledWith(SUB, "B1", { runId: undefined });
    const body = JSON.parse(res.body);
    expect(body.run.run_id).toBe("R1");
    expect(body.platforms[0]).toMatchObject({ platform: "dev", status: "succeeded", url: "https://dev/x" });
  });

  test("correlates to a specific run when run_id is given", async () => {
    getCrosspostStatus.mockResolvedValue({ run: null, copies: [] });
    await routes["GET /blogs/:blogId/crosspost-status"](ctx({ params: { blogId: "B1" }, query: { run_id: "R9" } }));
    expect(getCrosspostStatus).toHaveBeenCalledWith(SUB, "B1", { runId: "R9" });
  });
});

describe("auth", () => {
  test("rejects callers without dashboard sign-in", async () => {
    const noAuth = { event: { queryStringParameters: {} }, params: {} };
    await expect(routes["GET /blogs"](noAuth)).rejects.toThrow(/dashboard sign-in/);
  });
});
