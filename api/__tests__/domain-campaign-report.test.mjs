import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

// Mock the campaign domain + the analytics service so the snapshot mapping
// is exercised in isolation. Matches the unstable_mockModule idiom.
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  getCampaignWithLinks: jest.fn(),
}));
jest.unstable_mockModule("../services/campaign-analytics.mjs", () => ({
  getCampaignAnalytics: jest.fn(),
}));

const campaignDomain = await import("../domain/campaign.mjs");
const analyticsService = await import("../services/campaign-analytics.mjs");
const { buildCampaignReportSnapshot } = await import("../domain/campaign-report.mjs");

function analytics(overrides = {}) {
  return {
    campaign_id: "C1",
    link_count: 2,
    total_clicks: 0,
    by_role: {},
    by_platform: {},
    by_day: {},
    by_src: {},
    upstream_failures: 0,
    links: [],
    ...overrides,
  };
}

describe("domain/campaign-report buildCampaignReportSnapshot", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    campaignDomain.getCampaignWithLinks.mockReset();
    analyticsService.getCampaignAnalytics.mockReset();
    campaignDomain.getCampaignWithLinks.mockResolvedValue({
      metadata: {
        campaignId: "C1",
        name: "Spring launch",
        sponsor: "Acme",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        status: "active",
      },
    });
    analyticsService.getCampaignAnalytics.mockResolvedValue(analytics());
  });

  describe("not-found propagation", () => {
    test("throws NotFoundError when metadata is missing", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({ metadata: undefined });
      await expect(buildCampaignReportSnapshot({ campaignId: "C1" })).rejects.toThrow(
        /Campaign C1 not found/,
      );
      expect(analyticsService.getCampaignAnalytics).not.toHaveBeenCalled();
    });
  });

  describe("report envelope + campaign passthrough", () => {
    test("schemaVersion, kind, generatedAt/dataAsOf, campaign fields", async () => {
      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.schemaVersion).toBe(1);
      expect(snap.report.id).toBeNull();
      expect(snap.report.kind).toBe("campaign");
      expect(snap.report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(snap.report.dataAsOf).toBe(snap.report.generatedAt.slice(0, 10));
      expect(snap.campaign).toEqual({
        id: "C1",
        name: "Spring launch",
        sponsor: "Acme",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        status: "active",
      });
    });

    test("missing optional campaign fields become null", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: { campaignId: "C2", name: "Bare", status: "draft" },
      });
      const snap = await buildCampaignReportSnapshot({ campaignId: "C2" });
      expect(snap.campaign).toEqual({
        id: "C2",
        name: "Bare",
        sponsor: null,
        startDate: null,
        endDate: null,
        status: "draft",
      });
    });
  });

  describe("mapping + aggregation", () => {
    test("bySrc shares + sort, byDay sort, links sort, click bounds, summary", async () => {
      analyticsService.getCampaignAnalytics.mockResolvedValue(analytics({
        total_clicks: 20,
        link_count: 3,
        upstream_failures: 1,
        by_src: { nl: 5, tw: 15 },
        by_day: { "2026-03-02": 4, "2026-03-01": 16 },
        links: [
          {
            url: "https://a", short_url: "https://s/a", role: "primary", platform: "newsletter",
            total_clicks: 5, first_click_at: "2026-03-01T10:00:00.000Z", last_click_at: "2026-03-02T10:00:00.000Z",
          },
          {
            url: "https://b", short_url: "https://s/b", role: "secondary", platform: "twitter",
            total_clicks: 15, first_click_at: "2026-03-01T08:00:00.000Z", last_click_at: "2026-03-02T20:00:00.000Z",
          },
          {
            url: "https://c", short_url: null, role: "extra", platform: "linkedin",
            total_clicks: 0, first_click_at: null, last_click_at: null,
          },
        ],
      }));

      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });

      // bySrc sorted clicks desc with shares
      expect(snap.bySrc).toEqual([
        { source: "tw", clicks: 15, share: 0.75 },
        { source: "nl", clicks: 5, share: 0.25 },
      ]);
      // byDay sorted asc
      expect(snap.byDay).toEqual([
        { day: "2026-03-01", clicks: 16 },
        { day: "2026-03-02", clicks: 4 },
      ]);
      // links sorted by totalClicks desc, mapped fields
      expect(snap.links.map((l) => l.url)).toEqual(["https://b", "https://a", "https://c"]);
      expect(snap.links[0]).toEqual({
        url: "https://b", shortUrl: "https://s/b", role: "secondary", platform: "twitter",
        totalClicks: 15, firstClickAt: "2026-03-01T08:00:00.000Z", lastClickAt: "2026-03-02T20:00:00.000Z",
      });
      // click bounds: earliest first, latest last across links
      expect(snap.summary).toEqual({
        totalClicks: 20,
        linkCount: 3,
        firstClickAt: "2026-03-01T08:00:00.000Z",
        lastClickAt: "2026-03-02T20:00:00.000Z",
        upstreamFailures: 1,
      });
    });

    test("zero total clicks -> shares are 0, click bounds null", async () => {
      analyticsService.getCampaignAnalytics.mockResolvedValue(analytics({
        total_clicks: 0,
        by_src: { nl: 0 },
        links: [
          { url: "https://a", short_url: null, role: "primary", platform: "newsletter", total_clicks: 0, first_click_at: null, last_click_at: null },
        ],
      }));
      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.bySrc).toEqual([{ source: "nl", clicks: 0, share: 0 }]);
      expect(snap.summary.firstClickAt).toBeNull();
      expect(snap.summary.lastClickAt).toBeNull();
    });
  });
});
