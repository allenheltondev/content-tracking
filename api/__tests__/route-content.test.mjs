import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

jest.unstable_mockModule("../services/idempotency.mjs", () => ({ withIdempotency: (fn) => fn }));
jest.unstable_mockModule("../domain/content.mjs", () => ({
  createContent: jest.fn(),
  deleteContent: jest.fn(),
  getContent: jest.fn(),
  listContentByTenant: jest.fn(),
  updateContent: jest.fn(),
}));

const {
  createContent, deleteContent, getContent, listContentByTenant, updateContent,
} = await import("../domain/content.mjs");
const { registerContentRoutes } = await import("../routes/content.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    get: (p, h) => { routes[`GET ${p}`] = h; },
    post: (p, h) => { routes[`POST ${p}`] = h; },
    patch: (p, h) => { routes[`PATCH ${p}`] = h; },
    delete: (p, h) => { routes[`DELETE ${p}`] = h; },
  };
  registerContentRoutes(app);
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

beforeEach(() => jest.clearAllMocks());

describe("POST /content", () => {
  test("creates content scoped to the tenant", async () => {
    createContent.mockResolvedValue({ contentId: "C1", type: "blog", title: "Hi", slug: "hi", createdAt: "t0", updatedAt: "t0" });
    const res = await routes["POST /content"](ctx({
      body: { title: "Hi", type: "blog", slug: "hi", content_markdown: "b" },
    }));

    expect(res.statusCode).toBe(201);
    expect(createContent).toHaveBeenCalledWith(SUB, expect.objectContaining({
      title: "Hi", type: "blog", slug: "hi", contentMarkdown: "b", source: "owned", status: "draft",
    }));
    expect(JSON.parse(res.body).content_id).toBe("C1");
  });

  test("rejects an unauthenticated (non-cognito) caller", async () => {
    await expect(routes["POST /content"]({
      event: { body: JSON.stringify({ title: "Hi", type: "blog", slug: "hi", content_markdown: "b" }), requestContext: { authorizer: { authSource: "hmac" } } },
    })).rejects.toThrow(/dashboard sign-in/);
    expect(createContent).not.toHaveBeenCalled();
  });
});

describe("GET /content", () => {
  test("lists tenant content with summaries + cursor and passes filters", async () => {
    listContentByTenant.mockResolvedValue({
      items: [{ contentId: "C1", type: "blog", title: "a", slug: "a", createdAt: "t" }],
      lastEvaluatedKey: undefined,
    });
    const res = await routes["GET /content"](ctx({ query: { type: "blog", source: "owned", status: "published" } }));

    expect(listContentByTenant).toHaveBeenCalledWith(SUB, expect.objectContaining({
      type: "blog", source: "owned", status: "published",
    }));
    const body = JSON.parse(res.body);
    expect(body.content).toHaveLength(1);
    expect(body.content[0]).not.toHaveProperty("content_markdown");
    expect(body.nextStartKey).toBeNull();
  });
});

describe("GET /content/:contentId", () => {
  test("returns the full content for the tenant", async () => {
    getContent.mockResolvedValue({ contentId: "C1", type: "blog", title: "Hi", slug: "hi", contentMarkdown: "b", createdAt: "t", updatedAt: "t" });
    const res = await routes["GET /content/:contentId"](ctx({ params: { contentId: "C1" } }));
    expect(getContent).toHaveBeenCalledWith(SUB, "C1");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).content_markdown).toBe("b");
  });
});

describe("PATCH /content/:contentId", () => {
  test("updates the validated fields scoped to the tenant", async () => {
    updateContent.mockResolvedValue({ contentId: "C1", type: "blog", title: "New", slug: "hi", createdAt: "t", updatedAt: "t2" });
    const res = await routes["PATCH /content/:contentId"](ctx({ params: { contentId: "C1" }, body: { title: "New" } }));
    expect(updateContent).toHaveBeenCalledWith(SUB, "C1", { title: "New" });
    expect(JSON.parse(res.body).title).toBe("New");
  });

  test("rejects an empty update body", async () => {
    await expect(routes["PATCH /content/:contentId"](ctx({ params: { contentId: "C1" }, body: {} })))
      .rejects.toThrow(/at least one updatable field/);
    expect(updateContent).not.toHaveBeenCalled();
  });
});

describe("DELETE /content/:contentId", () => {
  test("deletes the content and returns 204", async () => {
    deleteContent.mockResolvedValue({ deleted: 1 });
    const res = await routes["DELETE /content/:contentId"](ctx({ params: { contentId: "C1" } }));
    expect(res.statusCode).toBe(204);
    expect(deleteContent).toHaveBeenCalledWith(SUB, "C1");
  });
});
