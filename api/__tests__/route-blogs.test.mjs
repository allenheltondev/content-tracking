import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

jest.unstable_mockModule("../domain/blog.mjs", () => ({
  createBlog: jest.fn(),
  getBlog: jest.fn(),
  listBlogsByTenant: jest.fn(),
  updateBlog: jest.fn(),
  deleteBlog: jest.fn(),
}));
// Pass-through so the POST handler runs without the Powertools idempotency
// machinery (which would otherwise need the persistence layer).
jest.unstable_mockModule("../services/idempotency.mjs", () => ({
  withIdempotency: (fn) => fn,
}));

const { createBlog, getBlog, listBlogsByTenant, updateBlog, deleteBlog } = await import("../domain/blog.mjs");
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

describe("auth", () => {
  test("rejects callers without dashboard sign-in", async () => {
    const noAuth = { event: { queryStringParameters: {} }, params: {} };
    await expect(routes["GET /blogs"](noAuth)).rejects.toThrow(/dashboard sign-in/);
  });
});
