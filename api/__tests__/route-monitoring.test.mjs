import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

jest.unstable_mockModule("../domain/social-post.mjs", () => ({
  listMonitoringWorkingSet: jest.fn(),
}));
jest.unstable_mockModule("../domain/content-post.mjs", () => ({
  listMonitoringContentPosts: jest.fn(),
}));
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  assertCampaignOwned: jest.fn(),
}));
jest.unstable_mockModule("../domain/campaign-report-link.mjs", () => ({
  publicReportLinkUrl: jest.fn(),
}));
jest.unstable_mockModule("../domain/campaign-refresh-request.mjs", () => ({
  listPendingRefreshRequests: jest.fn(),
}));
jest.unstable_mockModule("../services/campaign-report-refresh.mjs", () => ({
  completeMonitoringSweep: jest.fn(),
}));

const { listMonitoringWorkingSet } = await import("../domain/social-post.mjs");
const { listMonitoringContentPosts } = await import("../domain/content-post.mjs");
const { assertCampaignOwned } = await import("../domain/campaign.mjs");
const { publicReportLinkUrl } = await import("../domain/campaign-report-link.mjs");
const { listPendingRefreshRequests } = await import("../domain/campaign-refresh-request.mjs");
const { completeMonitoringSweep } = await import("../services/campaign-report-refresh.mjs");
const { NotFoundError } = await import("../services/errors.mjs");
const { registerMonitoringRoutes } = await import("../routes/monitoring.mjs");

const routes = {};
registerMonitoringRoutes({
  get: (path, handler) => { routes[`GET ${path}`] = handler; },
  post: (path, handler) => { routes[`POST ${path}`] = handler; },
});
const getWorkingSet = routes["GET /monitoring/working-set"];
const postSweepComplete = routes["POST /monitoring/campaigns/:campaignId/sweep-complete"];

const CAMPAIGN_ID = "01HV0AABBCCDDEEFFGGHHJJKKM";
// The extension authenticates with a pairing token; resolveTenantId accepts it.
const EXTENSION_EVENT = { requestContext: { authorizer: { authSource: "extension", sub: "tenant-1" } } };

describe("routes/monitoring", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listMonitoringWorkingSet.mockResolvedValue({ socialPosts: [], crossPostLinks: [] });
    listMonitoringContentPosts.mockResolvedValue([]);
    listPendingRefreshRequests.mockResolvedValue([]);
    assertCampaignOwned.mockResolvedValue({ campaignId: CAMPAIGN_ID });
    completeMonitoringSweep.mockResolvedValue({ regenerated: false });
  });

  describe("GET /monitoring/working-set", () => {
    test("includes the tenant's pending refresh requests", async () => {
      listPendingRefreshRequests.mockResolvedValue([
        { campaignId: "C1", requestedAt: "2026-11-18T08:00:00.000Z", tenantId: "tenant-1", expiresAt: 1 },
      ]);

      const res = await getWorkingSet({ event: EXTENSION_EVENT });

      expect(listPendingRefreshRequests).toHaveBeenCalledWith("tenant-1");
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).refresh_requests).toEqual([
        { campaign_id: "C1", requested_at: "2026-11-18T08:00:00.000Z" },
      ]);
    });

    test("always carries refresh_requests, empty when none are pending", async () => {
      const res = await getWorkingSet({ event: EXTENSION_EVENT });
      expect(JSON.parse(res.body)).toEqual({
        social_posts: [],
        content_posts: [],
        cross_post_links: [],
        refresh_requests: [],
      });
    });

    test("401 without a caller identity", async () => {
      await expect(getWorkingSet({ event: {} })).rejects.toMatchObject({ statusCode: 401 });
      expect(listPendingRefreshRequests).not.toHaveBeenCalled();
    });
  });

  describe("POST /monitoring/campaigns/:campaignId/sweep-complete", () => {
    test("checks ownership for the caller's tenant, then completes the sweep", async () => {
      completeMonitoringSweep.mockResolvedValue({ regenerated: true });
      publicReportLinkUrl.mockReturnValue("https://api.example.com/public/campaign-reports/TOKEN");

      const res = await postSweepComplete({
        event: { ...EXTENSION_EVENT, body: "{not json" },
        params: { campaignId: CAMPAIGN_ID },
      });

      expect(assertCampaignOwned).toHaveBeenCalledWith(CAMPAIGN_ID, "tenant-1");
      const args = completeMonitoringSweep.mock.calls[0][0];
      expect(args).toMatchObject({ tenantId: "tenant-1", campaignId: CAMPAIGN_ID });
      expect(args.latestUrlFor("TOKEN")).toBe("https://api.example.com/public/campaign-reports/TOKEN");
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ campaign_id: CAMPAIGN_ID, regenerated: true });
    });

    test("reports regenerated: false when there was nothing to do", async () => {
      const res = await postSweepComplete({ event: EXTENSION_EVENT, params: { campaignId: CAMPAIGN_ID } });
      expect(JSON.parse(res.body)).toEqual({ campaign_id: CAMPAIGN_ID, regenerated: false });
    });

    test("another tenant's campaign is a 404 and nothing runs", async () => {
      assertCampaignOwned.mockRejectedValue(new NotFoundError("Campaign", CAMPAIGN_ID));
      await expect(
        postSweepComplete({ event: EXTENSION_EVENT, params: { campaignId: CAMPAIGN_ID } }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(completeMonitoringSweep).not.toHaveBeenCalled();
    });

    test("400 on a malformed campaign id", async () => {
      await expect(
        postSweepComplete({ event: EXTENSION_EVENT, params: { campaignId: "bad id!" } }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(assertCampaignOwned).not.toHaveBeenCalled();
    });

    test("401 without a caller identity", async () => {
      await expect(
        postSweepComplete({ event: {}, params: { campaignId: CAMPAIGN_ID } }),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(assertCampaignOwned).not.toHaveBeenCalled();
    });
  });
});
