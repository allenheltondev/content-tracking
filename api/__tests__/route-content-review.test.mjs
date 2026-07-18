import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

jest.unstable_mockModule("../domain/content.mjs", () => ({ getContent: jest.fn() }));
jest.unstable_mockModule("../domain/content-review.mjs", () => ({
  createReview: jest.fn(),
  getReview: jest.fn(),
  getLatestReview: jest.fn(),
  listSuggestions: jest.fn(),
  updateSuggestionStatus: jest.fn(),
}));

const { getContent } = await import("../domain/content.mjs");
const {
  createReview,
  getReview,
  getLatestReview,
  listSuggestions,
  updateSuggestionStatus,
} = await import("../domain/content-review.mjs");
const { registerContentReviewRoutes } = await import("../routes/content-review.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    get: (p, h) => { routes[`GET ${p}`] = h; },
    post: (p, h) => { routes[`POST ${p}`] = h; },
    put: (p, h) => { routes[`PUT ${p}`] = h; },
    patch: (p, h) => { routes[`PATCH ${p}`] = h; },
    delete: (p, h) => { routes[`DELETE ${p}`] = h; },
  };
  registerContentReviewRoutes(app);
  return routes;
}
const routes = buildRouteTable();
const SUB = "user-1";
const CONTENT_ID = "01HCONTENT";

function ctx({ body, params, authSource = "cognito" } = {}) {
  return {
    event: {
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: { authorizer: { authSource, sub: SUB } },
    },
    params: { contentId: CONTENT_ID, ...params },
  };
}

beforeEach(() => jest.clearAllMocks());

describe("POST /content/:contentId/reviews", () => {
  test("opens a pending review stamped with the content version", async () => {
    getContent.mockResolvedValue({ contentMarkdown: "Hello world.", updatedAt: "2026-07-18T00:00:00Z" });
    createReview.mockResolvedValue({ reviewId: "rev-1", status: "pending", createdAt: "t", updatedAt: "t" });

    const res = await routes["POST /content/:contentId/reviews"](ctx({}));

    expect(res.statusCode).toBe(202);
    expect(createReview).toHaveBeenCalledWith(SUB, CONTENT_ID, { contentVersion: "2026-07-18T00:00:00Z" });
    expect(JSON.parse(res.body).id).toBe("rev-1");
  });

  test("rejects an empty-bodied content piece with 400", async () => {
    getContent.mockResolvedValue({ contentMarkdown: "   ", updatedAt: "t" });
    await expect(routes["POST /content/:contentId/reviews"](ctx({}))).rejects.toMatchObject({ statusCode: 400 });
    expect(createReview).not.toHaveBeenCalled();
  });

  test("requires dashboard sign-in", async () => {
    await expect(
      routes["POST /content/:contentId/reviews"](ctx({ authSource: "extension" })),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(getContent).not.toHaveBeenCalled();
  });

  test("propagates 404 when the content does not exist", async () => {
    getContent.mockRejectedValue(Object.assign(new Error("x"), { statusCode: 404 }));
    await expect(routes["POST /content/:contentId/reviews"](ctx({}))).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("GET /content/:contentId/suggestions", () => {
  test("returns pending suggestions plus the latest review summary", async () => {
    getContent.mockResolvedValue({ contentMarkdown: "x", updatedAt: "t" });
    listSuggestions.mockResolvedValue([
      {
        suggestionId: "s1", type: "grammar", priority: "high", reason: "run-on", status: "pending",
        startOffset: 4, endOffset: 9, anchorText: "quick", replaceWith: "swift",
        contextBefore: "The ", contextAfter: " brown", createdAt: "t",
      },
    ]);
    getLatestReview.mockResolvedValue({ reviewId: "rev-1", status: "succeeded", summary: "Looks good.", createdAt: "t", updatedAt: "t" });

    const res = await routes["GET /content/:contentId/suggestions"](ctx({}));
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.suggestions[0]).toMatchObject({ id: "s1", text_to_replace: "quick", replace_with: "swift", start_offset: 4 });
    expect(body.review).toMatchObject({ id: "rev-1", summary: "Looks good." });
  });
});

describe("POST /content/:contentId/suggestions/:suggestionId/status", () => {
  test("records an accepted decision", async () => {
    getContent.mockResolvedValue({ contentMarkdown: "x", updatedAt: "t" });
    updateSuggestionStatus.mockResolvedValue({ suggestionId: "s1", status: "accepted", type: "grammar", priority: "high", reason: "r", anchorText: "quick", replaceWith: "swift", startOffset: 0, endOffset: 5, createdAt: "t" });

    const res = await routes["POST /content/:contentId/suggestions/:suggestionId/status"](
      ctx({ body: { status: "accepted" }, params: { suggestionId: "s1" } }),
    );

    expect(res.statusCode).toBe(200);
    expect(updateSuggestionStatus).toHaveBeenCalledWith(SUB, CONTENT_ID, "s1", "accepted");
    expect(JSON.parse(res.body).status).toBe("accepted");
  });

  test("rejects an invalid status value", async () => {
    await expect(
      routes["POST /content/:contentId/suggestions/:suggestionId/status"](
        ctx({ body: { status: "banana" }, params: { suggestionId: "s1" } }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(updateSuggestionStatus).not.toHaveBeenCalled();
  });
});

describe("GET /content/:contentId/reviews/:reviewId", () => {
  test("returns the review status", async () => {
    getContent.mockResolvedValue({ contentMarkdown: "x", updatedAt: "t" });
    getReview.mockResolvedValue({ reviewId: "rev-1", status: "pending", createdAt: "t", updatedAt: "t" });

    const res = await routes["GET /content/:contentId/reviews/:reviewId"](ctx({ params: { reviewId: "rev-1" } }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: "rev-1", status: "pending" });
  });
});
