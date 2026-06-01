import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

// Mock every collaborator so the route logic is exercised in isolation: the
// Bedrock call, the campaign read that gathers distribution context, and the
// recommendation store.
jest.unstable_mockModule("../services/bedrock.mjs", () => ({
  recommendEngagement: jest.fn(),
}));
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  getCampaignWithLinks: jest.fn(),
}));
jest.unstable_mockModule("../domain/engagement-recommendation.mjs", () => ({
  saveEngagementRecommendation: jest.fn(),
  getEngagementRecommendation: jest.fn(),
}));

const { recommendEngagement } = await import("../services/bedrock.mjs");
const { getCampaignWithLinks } = await import("../domain/campaign.mjs");
const { saveEngagementRecommendation, getEngagementRecommendation } = await import(
  "../domain/engagement-recommendation.mjs"
);
const { NotFoundError } = await import("../services/errors.mjs");
const { registerContentRecommendationRoutes } = await import("../routes/content-recommendations.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    post: (path, handler) => { routes[`POST ${path}`] = handler; },
    get: (path, handler) => { routes[`GET ${path}`] = handler; },
  };
  registerContentRecommendationRoutes(app);
  return routes;
}

const routes = buildRouteTable();
const postRecs = routes["POST /campaigns/:campaignId/content-posts/:postId/recommendations"];
const getRecs = routes["GET /campaigns/:campaignId/content-posts/:postId/recommendations"];

const CAMPAIGN_ID = "01HV0AABBCCDDEEFFGGHHJJKKM";
const POST_ID = "01HV0CONTENTPOST0000000001";

function makeCampaignBundle(overrides = {}) {
  return {
    metadata: { campaignId: CAMPAIGN_ID, name: "Launch", targetMetrics: { signups: 100 } },
    links: [
      { linkId: "L1", role: "cross_post", platform: "x", url: "https://x.com/p/1" },
      { linkId: "L2", role: "main", platform: "blog", url: "https://blog/p" },
    ],
    socialPosts: [
      { postId: "S1", platform: "linkedin", url: "https://linkedin.com/p/3", notes: "Excited!" },
    ],
    contentPosts: [
      { postId: POST_ID, platform: "medium", url: "https://medium.com/p/abc", notes: "deep dive" },
      { postId: "OTHER", platform: "devto", url: "https://dev.to/p/2" },
    ],
    brief: { summary: "Promote Acme" },
    draft: null,
    ...overrides,
  };
}

describe("routes/content-recommendations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("registers the POST and GET routes", () => {
    expect(typeof postRecs).toBe("function");
    expect(typeof getRecs).toBe("function");
  });

  describe("POST", () => {
    test("gathers context, calls Bedrock, stores, and returns 201", async () => {
      getCampaignWithLinks.mockResolvedValue(makeCampaignBundle());
      recommendEngagement.mockResolvedValue({
        summary: "Push to dev communities.",
        recommendations: [
          { channel: "reddit r/webdev", action: "promote", priority: "high", rationale: "fit", suggested_message: "hi" },
        ],
        already_covered: ["x"],
      });
      saveEngagementRecommendation.mockResolvedValue({
        campaignId: CAMPAIGN_ID,
        postId: POST_ID,
        summary: "Push to dev communities.",
        recommendations: [
          { channel: "reddit r/webdev", action: "promote", priority: "high", rationale: "fit", suggested_message: "hi" },
        ],
        alreadyCovered: ["x"],
        generatedAt: "2026-06-01T00:00:00.000Z",
      });

      const res = await postRecs({
        event: { body: JSON.stringify({ goal: "developer signups" }) },
        params: { campaignId: CAMPAIGN_ID, postId: POST_ID },
      });

      // Bedrock got the work item plus the pre-filtered distribution context:
      // only cross-post links, only sibling content posts, all social posts.
      const arg = recommendEngagement.mock.calls[0][0];
      expect(arg.contentPost.postId).toBe(POST_ID);
      expect(arg.campaign.name).toBe("Launch");
      expect(arg.brief.summary).toBe("Promote Acme");
      expect(arg.crossPostLinks).toHaveLength(1);
      expect(arg.crossPostLinks[0].role).toBe("cross_post");
      expect(arg.otherContentPosts.map((p) => p.postId)).toEqual(["OTHER"]);
      expect(arg.socialPosts).toHaveLength(1);
      expect(arg.goal).toBe("developer signups");

      expect(saveEngagementRecommendation).toHaveBeenCalledWith(
        CAMPAIGN_ID,
        POST_ID,
        expect.objectContaining({ summary: "Push to dev communities." }),
      );

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.campaign_id).toBe(CAMPAIGN_ID);
      expect(body.recommendations[0].channel).toBe("reddit r/webdev");
      expect(body.already_covered).toEqual(["x"]);
    });

    test("works with no body (no goal)", async () => {
      getCampaignWithLinks.mockResolvedValue(makeCampaignBundle());
      recommendEngagement.mockResolvedValue({ summary: "x", recommendations: [] });
      saveEngagementRecommendation.mockResolvedValue({
        campaignId: CAMPAIGN_ID, postId: POST_ID, summary: "x", recommendations: [], alreadyCovered: [], generatedAt: "t",
      });

      const res = await postRecs({ event: { body: null }, params: { campaignId: CAMPAIGN_ID, postId: POST_ID } });

      expect(res.statusCode).toBe(201);
      expect(recommendEngagement.mock.calls[0][0].goal).toBeUndefined();
    });

    test("404 when the content post isn't on the campaign", async () => {
      getCampaignWithLinks.mockResolvedValue(makeCampaignBundle({ contentPosts: [] }));

      await expect(
        postRecs({ event: { body: null }, params: { campaignId: CAMPAIGN_ID, postId: POST_ID } }),
      ).rejects.toThrow(/ContentPost .* not found/);
      expect(recommendEngagement).not.toHaveBeenCalled();
      expect(saveEngagementRecommendation).not.toHaveBeenCalled();
    });

    test("propagates NotFound from the campaign read", async () => {
      getCampaignWithLinks.mockRejectedValue(new NotFoundError("Campaign", CAMPAIGN_ID));
      await expect(
        postRecs({ event: { body: null }, params: { campaignId: CAMPAIGN_ID, postId: POST_ID } }),
      ).rejects.toThrow(/Campaign .* not found/);
      expect(recommendEngagement).not.toHaveBeenCalled();
    });

    test("does not persist when Bedrock fails", async () => {
      getCampaignWithLinks.mockResolvedValue(makeCampaignBundle());
      recommendEngagement.mockRejectedValue(new Error("bedrock boom"));

      await expect(
        postRecs({ event: { body: null }, params: { campaignId: CAMPAIGN_ID, postId: POST_ID } }),
      ).rejects.toThrow(/bedrock boom/);
      expect(saveEngagementRecommendation).not.toHaveBeenCalled();
    });

    test("400 on an invalid goal", async () => {
      await expect(
        postRecs({
          event: { body: JSON.stringify({ goal: "x".repeat(501) }) },
          params: { campaignId: CAMPAIGN_ID, postId: POST_ID },
        }),
      ).rejects.toThrow(/up to 500/);
      expect(getCampaignWithLinks).not.toHaveBeenCalled();
    });
  });

  describe("GET", () => {
    test("returns the stored recommendation", async () => {
      getEngagementRecommendation.mockResolvedValue({
        campaignId: CAMPAIGN_ID,
        postId: POST_ID,
        summary: "stored",
        recommendations: [],
        alreadyCovered: [],
        generatedAt: "2026-06-01T00:00:00.000Z",
      });

      const res = await getRecs({ params: { campaignId: CAMPAIGN_ID, postId: POST_ID } });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).summary).toBe("stored");
      expect(getEngagementRecommendation).toHaveBeenCalledWith(CAMPAIGN_ID, POST_ID);
    });

    test("404 when nothing has been generated yet", async () => {
      getEngagementRecommendation.mockResolvedValue(null);
      await expect(
        getRecs({ params: { campaignId: CAMPAIGN_ID, postId: POST_ID } }),
      ).rejects.toThrow(/ContentPostRecommendation .* not found/);
    });
  });
});
