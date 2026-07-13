import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

// Idempotency is a pass-through so handlers run inline; the domain and the
// campaign ownership guard are mocked so we exercise the route's auth wiring
// in isolation.
jest.unstable_mockModule("../services/idempotency.mjs", () => ({ withIdempotency: (fn) => fn }));
jest.unstable_mockModule("../domain/social-post.mjs", () => ({
  createSocialPost: jest.fn(),
  deleteSocialPost: jest.fn(),
  listActiveCampaignSocialPosts: jest.fn(),
  listSocialPostSnapshots: jest.fn(),
  listSocialPosts: jest.fn(),
  updateSocialPostAnalytics: jest.fn(),
}));
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  assertCampaignOwned: jest.fn(),
}));

const { updateSocialPostAnalytics } = await import("../domain/social-post.mjs");
const { assertCampaignOwned } = await import("../domain/campaign.mjs");
const { registerSocialPostRoutes } = await import("../routes/social-posts.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    get: (p, h) => { routes[`GET ${p}`] = h; },
    post: (p, h) => { routes[`POST ${p}`] = h; },
    put: (p, h) => { routes[`PUT ${p}`] = h; },
    delete: (p, h) => { routes[`DELETE ${p}`] = h; },
  };
  registerSocialPostRoutes(app);
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

describe("routes/social-posts — analytics write auth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertCampaignOwned.mockResolvedValue({ campaignId: "CMP1", tenantId: SUB });
    updateSocialPostAnalytics.mockResolvedValue({ postId: "P1", analytics: { likes: 5 } });
  });

  const handler = () => routes["PUT /campaigns/:campaignId/social-posts/:postId/analytics"];

  test("accepts the Chrome extension's pairing-token auth (authSource=extension)", async () => {
    const res = await handler()(ctx({
      authSource: "extension",
      body: { metrics: { likes: 5 } },
      params: { campaignId: "CMP1", postId: "P1" },
    }));

    expect(res.statusCode).toBe(200);
    // Ownership still enforced, scoped to the sub the authorizer supplied.
    expect(assertCampaignOwned).toHaveBeenCalledWith("CMP1", SUB);
    expect(updateSocialPostAnalytics).toHaveBeenCalledWith("CMP1", "P1", { metrics: { likes: 5 } });
  });

  test("still accepts dashboard (cognito) auth", async () => {
    const res = await handler()(ctx({
      authSource: "cognito",
      body: { metrics: { likes: 5 } },
      params: { campaignId: "CMP1", postId: "P1" },
    }));
    expect(res.statusCode).toBe(200);
    expect(assertCampaignOwned).toHaveBeenCalledWith("CMP1", SUB);
  });

  test("rejects an unauthenticated caller (no sub)", async () => {
    // No sub → resolveTenantId throws before the domain is touched.
    const noSub = {
      event: { body: JSON.stringify({ metrics: { likes: 5 } }), requestContext: { authorizer: {} } },
      params: { campaignId: "CMP1", postId: "P1" },
    };
    await expect(handler()(noSub)).rejects.toThrow(/caller identity/i);
    expect(updateSocialPostAnalytics).not.toHaveBeenCalled();
  });
});
