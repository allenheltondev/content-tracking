import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

jest.unstable_mockModule("../services/idempotency.mjs", () => ({ withIdempotency: (fn) => fn }));
jest.unstable_mockModule("../domain/content-post.mjs", () => ({
  createContentPost: jest.fn(),
  deleteContentPost: jest.fn(),
  listContentPostSnapshots: jest.fn(),
  listContentPosts: jest.fn(),
  updateContentPostAnalytics: jest.fn(),
}));
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  assertCampaignOwned: jest.fn(),
}));

const { updateContentPostAnalytics } = await import("../domain/content-post.mjs");
const { assertCampaignOwned } = await import("../domain/campaign.mjs");
const { registerContentPostRoutes } = await import("../routes/content-posts.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    get: (p, h) => { routes[`GET ${p}`] = h; },
    post: (p, h) => { routes[`POST ${p}`] = h; },
    put: (p, h) => { routes[`PUT ${p}`] = h; },
    delete: (p, h) => { routes[`DELETE ${p}`] = h; },
  };
  registerContentPostRoutes(app);
  return routes;
}
const routes = buildRouteTable();
const SUB = "user-1";

function ctx({ authSource, body, params } = {}) {
  return {
    event: {
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: { authorizer: { authSource, sub: SUB } },
    },
    params,
  };
}

describe("routes/content-posts — analytics write auth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertCampaignOwned.mockResolvedValue({ campaignId: "CMP1", tenantId: SUB });
    updateContentPostAnalytics.mockResolvedValue({ postId: "P1", analytics: { views: 9 } });
  });

  const handler = () => routes["PUT /campaigns/:campaignId/content-posts/:postId/analytics"];

  test("accepts the Chrome extension's pairing-token auth (authSource=extension)", async () => {
    const res = await handler()(ctx({
      authSource: "extension",
      body: { metrics: { views: 9 } },
      params: { campaignId: "CMP1", postId: "P1" },
    }));

    expect(res.statusCode).toBe(200);
    expect(assertCampaignOwned).toHaveBeenCalledWith("CMP1", SUB);
    expect(updateContentPostAnalytics).toHaveBeenCalledWith("CMP1", "P1", { metrics: { views: 9 } });
  });

  test("rejects an unauthenticated caller (no sub)", async () => {
    const noSub = {
      event: { body: JSON.stringify({ metrics: { views: 9 } }), requestContext: { authorizer: {} } },
      params: { campaignId: "CMP1", postId: "P1" },
    };
    await expect(handler()(noSub)).rejects.toThrow(/caller identity/i);
    expect(updateContentPostAnalytics).not.toHaveBeenCalled();
  });
});
