import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

// Mock the campaign domain + the analytics + GA4 services so the snapshot
// mapping is exercised in isolation. Matches the unstable_mockModule idiom.
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  getCampaignWithLinks: jest.fn(),
}));
jest.unstable_mockModule("../services/campaign-analytics.mjs", () => ({
  getCampaignAnalytics: jest.fn(),
}));
jest.unstable_mockModule("../services/campaign-ga4.mjs", () => ({
  loadCampaignGa4: jest.fn(),
}));

const campaignDomain = await import("../domain/campaign.mjs");
const analyticsService = await import("../services/campaign-analytics.mjs");
const ga4Service = await import("../services/campaign-ga4.mjs");
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
    ga4Service.loadCampaignGa4.mockReset();
    campaignDomain.getCampaignWithLinks.mockResolvedValue({
      metadata: {
        campaignId: "C1",
        name: "Spring launch",
        sponsor: "Acme",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        status: "active",
      },
      socialPosts: [],
      contentPosts: [],
    });
    analyticsService.getCampaignAnalytics.mockResolvedValue(analytics());
    ga4Service.loadCampaignGa4.mockResolvedValue(null);
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
        socialPosts: [],
        contentPosts: [],
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
      // links sorted by totalClicks desc, mapped fields. The customer
      // report intentionally drops short_url + first/last clicked.
      expect(snap.links.map((l) => l.url)).toEqual(["https://b", "https://a", "https://c"]);
      expect(snap.links[0]).toEqual({
        url: "https://b", role: "secondary", platform: "twitter", totalClicks: 15,
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

    test("mainContent is null when GA4 returns nothing", async () => {
      ga4Service.loadCampaignGa4.mockResolvedValue(null);
      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.mainContent).toBeNull();
    });

    test("mainContent is null when GA4 isn't configured", async () => {
      ga4Service.loadCampaignGa4.mockResolvedValue({
        configured: false, error: null, blog_url: "https://blog/p",
      });
      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.mainContent).toBeNull();
    });

    test("mainContent is null when GA4 errored", async () => {
      ga4Service.loadCampaignGa4.mockResolvedValue({
        configured: true, error: "boom", blog_url: "https://blog/p",
      });
      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.mainContent).toBeNull();
    });

    test("mainContent maps GA4 totals when successful", async () => {
      ga4Service.loadCampaignGa4.mockResolvedValue({
        configured: true,
        error: null,
        blog_url: "https://blog/p",
        property_id: "1",
        page_path: "/p",
        range: { startDate: "2026-03-01", endDate: "2026-03-28" },
        totals: {
          pageviews: 1500,
          users: 1000,
          sessions: 1200,
          avg_session_duration: 124.5,
          engagement_rate: 0.72,
          bounce_rate: 0.28,
        },
        by_day: { "2026-03-01": 100 },
      });
      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.mainContent).toEqual({
        blogUrl: "https://blog/p",
        range: { startDate: "2026-03-01", endDate: "2026-03-28" },
        pageviews: 1500,
        users: 1000,
        sessions: 1200,
        avgSessionDurationSeconds: 124.5,
        engagementRate: 0.72,
      });
    });

    test("socialPosts and contentPosts: total engagement + top metric, sorted desc", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: { campaignId: "C1", name: "x", status: "active" },
        socialPosts: [
          {
            platform: "twitter", url: "https://t.co/a", notes: "n",
            analytics: { likes: 5, retweets: 2 }, lastFetched: "2026-03-02T10:00:00.000Z",
          },
          {
            platform: "linkedin", url: "https://li/b", notes: null,
            analytics: { reactions: 30, comments: 4 }, lastFetched: null,
          },
        ],
        contentPosts: [
          {
            platform: "medium", url: "https://m/x", notes: null,
            analytics: { reads: 200, views: 800 }, lastFetched: "2026-03-03T10:00:00.000Z",
          },
        ],
      });
      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      // LinkedIn (34) ahead of twitter (7).
      expect(snap.socialPosts).toEqual([
        {
          platform: "linkedin", url: "https://li/b", notes: null,
          totalEngagement: 34, topMetric: "reactions", topMetricValue: 30, lastFetched: null,
        },
        {
          platform: "twitter", url: "https://t.co/a", notes: "n",
          totalEngagement: 7, topMetric: "likes", topMetricValue: 5,
          lastFetched: "2026-03-02T10:00:00.000Z",
        },
      ]);
      expect(snap.contentPosts).toEqual([
        {
          platform: "medium", url: "https://m/x", notes: null,
          totalEngagement: 1000, topMetric: "views", topMetricValue: 800,
          lastFetched: "2026-03-03T10:00:00.000Z",
        },
      ]);
    });

    test("posts with no analytics map to zero engagement, null top metric", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: { campaignId: "C1", name: "x", status: "active" },
        socialPosts: [
          { platform: "twitter", url: "https://t.co/a", analytics: null, lastFetched: null },
        ],
        contentPosts: [],
      });
      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.socialPosts[0]).toEqual({
        platform: "twitter", url: "https://t.co/a", notes: null,
        totalEngagement: 0, topMetric: null, topMetricValue: 0, lastFetched: null,
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
