import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

// The orchestration in services/campaign-report-refresh.mjs, with every
// collaborator mocked at its module boundary. The public refresh path is
// covered end to end through the route in route-campaign-reports.test.mjs;
// this file covers the extension's sweep-complete decisions.
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  findCampaign: jest.fn(),
  getCampaignWithLinks: jest.fn(),
}));
jest.unstable_mockModule("../domain/campaign-report-link.mjs", () => ({
  claimCampaignReportRefresh: jest.fn(),
  getCampaignReportLinkToken: jest.fn(),
}));
jest.unstable_mockModule("../domain/campaign-report-record.mjs", () => ({
  findNewestCampaignReportRecord: jest.fn(),
}));
jest.unstable_mockModule("../domain/campaign-refresh-request.mjs", () => ({
  recordRefreshRequest: jest.fn(),
  getRefreshRequest: jest.fn(),
  clearRefreshRequest: jest.fn(),
}));
jest.unstable_mockModule("../services/campaign-reports.mjs", () => ({
  findNewestServableCampaignReport: jest.fn(),
  generateCampaignReport: jest.fn(),
}));

const { getCampaignWithLinks } = await import("../domain/campaign.mjs");
const { getCampaignReportLinkToken } = await import("../domain/campaign-report-link.mjs");
const { findNewestCampaignReportRecord } = await import("../domain/campaign-report-record.mjs");
const { getRefreshRequest, clearRefreshRequest } = await import("../domain/campaign-refresh-request.mjs");
const { generateCampaignReport } = await import("../services/campaign-reports.mjs");
const { completeMonitoringSweep, PUBLIC_REFRESH_COOLDOWN_MINUTES } = await import(
  "../services/campaign-report-refresh.mjs"
);

const TENANT = "tenant-1";
const CAMPAIGN_ID = "01HV0AABBCCDDEEFFGGHHJJKKM";
const REPORT_AT = "2026-11-18T10:00:00.000Z";
const latestUrlFor = (token) => `https://api.example.com/public/campaign-reports/${token}`;

function arrange({ pending = null, token = "TOKEN", posts = [] } = {}) {
  getRefreshRequest.mockResolvedValue(pending);
  getCampaignReportLinkToken.mockResolvedValue(token);
  findNewestCampaignReportRecord.mockResolvedValue({ reportId: "R1", generatedAt: REPORT_AT });
  getCampaignWithLinks.mockResolvedValue({ socialPosts: posts, contentPosts: [] });
  generateCampaignReport.mockResolvedValue({ url: "https://cdn/new?sig" });
  clearRefreshRequest.mockResolvedValue(true);
}

const sweep = () => completeMonitoringSweep({ tenantId: TENANT, campaignId: CAMPAIGN_ID, latestUrlFor });

describe("services/campaign-report-refresh completeMonitoringSweep", () => {
  beforeEach(() => jest.clearAllMocks());

  test("the public cooldown is ten minutes", () => {
    expect(PUBLIC_REFRESH_COOLDOWN_MINUTES).toBe(10);
  });

  test("a pending request regenerates and is cleared, matched on its requestedAt", async () => {
    arrange({ pending: { campaignId: CAMPAIGN_ID, requestedAt: "2026-11-18T11:00:00.000Z" } });

    await expect(sweep()).resolves.toEqual({ regenerated: true });

    expect(getRefreshRequest).toHaveBeenCalledWith(TENANT, CAMPAIGN_ID);
    expect(generateCampaignReport).toHaveBeenCalledWith({ campaignId: CAMPAIGN_ID, latestUrlFor });
    expect(clearRefreshRequest).toHaveBeenCalledWith(TENANT, CAMPAIGN_ID, "2026-11-18T11:00:00.000Z");
    // The pending request alone decides; no post scan needed.
    expect(getCampaignWithLinks).not.toHaveBeenCalled();
  });

  test("posts synced after the newest report regenerate without a request", async () => {
    arrange({
      posts: [
        { lastFetched: "2026-11-18T09:00:00.000Z" },
        { lastFetched: "2026-11-18T10:05:00.000Z" },
      ],
    });

    await expect(sweep()).resolves.toEqual({ regenerated: true });
    expect(generateCampaignReport).toHaveBeenCalled();
    expect(clearRefreshRequest).not.toHaveBeenCalled();
  });

  test("content posts count as well as social posts", async () => {
    arrange();
    getCampaignWithLinks.mockResolvedValue({
      socialPosts: [],
      contentPosts: [{ lastFetched: "2026-11-18T12:00:00.000Z" }],
    });
    await expect(sweep()).resolves.toEqual({ regenerated: true });
  });

  test("skips when nothing is pending and no post synced since the report", async () => {
    arrange({
      posts: [{ lastFetched: "2026-11-18T09:59:59.000Z" }, { lastFetched: null }, {}],
    });

    await expect(sweep()).resolves.toEqual({ regenerated: false });
    expect(generateCampaignReport).not.toHaveBeenCalled();
  });

  test("never mints a sponsor link: no token means no regeneration, but the request is cleared", async () => {
    arrange({ token: null, pending: { campaignId: CAMPAIGN_ID, requestedAt: "2026-11-18T11:00:00.000Z" } });

    await expect(sweep()).resolves.toEqual({ regenerated: false });
    expect(generateCampaignReport).not.toHaveBeenCalled();
    expect(clearRefreshRequest).toHaveBeenCalledWith(TENANT, CAMPAIGN_ID, "2026-11-18T11:00:00.000Z");
  });

  test("a campaign with a link but no stored report regenerates once posts have synced", async () => {
    arrange({ posts: [{ lastFetched: "2026-01-01T00:00:00.000Z" }] });
    findNewestCampaignReportRecord.mockResolvedValue(null);
    await expect(sweep()).resolves.toEqual({ regenerated: true });
  });

  test("a failed generation keeps the pending request for the next sweep", async () => {
    arrange({ pending: { campaignId: CAMPAIGN_ID, requestedAt: "2026-11-18T11:00:00.000Z" } });
    generateCampaignReport.mockRejectedValue(new Error("upstream down"));

    await expect(sweep()).rejects.toThrow("upstream down");
    expect(clearRefreshRequest).not.toHaveBeenCalled();
  });
});
