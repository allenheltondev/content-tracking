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
jest.unstable_mockModule("../services/campaign-youtube.mjs", () => ({
  loadCampaignYoutube: jest.fn(),
}));
jest.unstable_mockModule("../domain/profile.mjs", () => ({
  getProfileSettings: jest.fn(),
}));

const campaignDomain = await import("../domain/campaign.mjs");
const analyticsService = await import("../services/campaign-analytics.mjs");
const ga4Service = await import("../services/campaign-ga4.mjs");
const youtubeService = await import("../services/campaign-youtube.mjs");
const profileDomain = await import("../domain/profile.mjs");
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
    profileDomain.getProfileSettings.mockReset();
    profileDomain.getProfileSettings.mockResolvedValue(null);
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
    youtubeService.loadCampaignYoutube.mockReset();
    youtubeService.loadCampaignYoutube.mockResolvedValue(null);
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
      });
      expect(snap.brand).toBeNull();
    });

    test("brand is null without a configured name, populated from the profile otherwise", async () => {
      let snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.brand).toBeNull();

      profileDomain.getProfileSettings.mockResolvedValue({
        brandName: "Ready, Set, Cloud!",
        websiteUrl: "https://readysetcloud.io",
      });
      snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.brand).toEqual({
        name: "Ready, Set, Cloud!",
        websiteUrl: "https://readysetcloud.io",
      });

      // Website is optional; name alone is enough to render the brand bar.
      profileDomain.getProfileSettings.mockResolvedValue({ brandName: "Solo" });
      snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.brand).toEqual({ name: "Solo", websiteUrl: null });
    });

    test("theme carries the profile accent color, only when a valid hex", async () => {
      let snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.theme).toEqual({ accentColor: null });

      profileDomain.getProfileSettings.mockResolvedValue({ accentColor: "#1a2b3c" });
      snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.theme).toEqual({ accentColor: "#1a2b3c" });

      // Shorthand hex is accepted; anything non-hex is dropped to null.
      profileDomain.getProfileSettings.mockResolvedValue({ accentColor: "#abc" });
      snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.theme).toEqual({ accentColor: "#abc" });

      profileDomain.getProfileSettings.mockResolvedValue({ accentColor: "blue" });
      snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.theme).toEqual({ accentColor: null });
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
      });
    });
  });

  describe("mapping + aggregation", () => {
    test("bySrc shares + sort, byDay sort, links sort, summary", async () => {
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
        url: "https://b", role: "secondary", platform: "twitter", source: null, totalClicks: 15,
      });
      // summary no longer carries click bounds — just the click totals.
      expect(snap.summary).toEqual({
        totalClicks: 20,
        linkCount: 3,
        upstreamFailures: 1,
      });
    });

    test("link source rides through when present (source or src), null otherwise", async () => {
      analyticsService.getCampaignAnalytics.mockResolvedValue(analytics({
        total_clicks: 30,
        links: [
          { url: "https://a", role: null, platform: null, source: "in-article", total_clicks: 20 },
          { url: "https://b", role: null, platform: null, src: "footer", total_clicks: 10 },
          { url: "https://c", role: null, platform: null, total_clicks: 0 },
        ],
      }));
      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      const bySource = Object.fromEntries(snap.links.map((l) => [l.url, l.source]));
      expect(bySource).toEqual({
        "https://a": "in-article",
        "https://b": "footer",
        "https://c": null,
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
      // Main content feeds the content bucket with pageviews -> views only;
      // GA4 engagement rate is shown elsewhere, not summed into engagements.
      expect(snap.reach.content).toEqual({ views: 1500, impressions: 0, engagements: 0 });
      expect(snap.reach.totals).toEqual({ views: 1500, impressions: 0, engagements: 0 });
    });

    test("YouTube campaign maps video stats into mainContent and reach", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: {
          campaignId: "C1",
          name: "Video push",
          status: "active",
          deliverableType: "youtube",
          youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
        },
        socialPosts: [],
        contentPosts: [],
      });
      youtubeService.loadCampaignYoutube.mockResolvedValue({
        configured: true,
        error: null,
        youtube_url: "https://youtu.be/dQw4w9WgXcQ",
        video_id: "dQw4w9WgXcQ",
        title: "How to ship faster",
        published_at: "2026-03-01T00:00:00Z",
        totals: { views: 9000, likes: 450, comments: 60, favorites: 0 },
      });

      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });

      // A YouTube campaign pulls from the YouTube loader, not GA4.
      expect(ga4Service.loadCampaignGa4).not.toHaveBeenCalled();
      expect(snap.mainContent).toEqual({
        kind: "youtube",
        videoUrl: "https://youtu.be/dQw4w9WgXcQ",
        title: "How to ship faster",
        publishedAt: "2026-03-01T00:00:00Z",
        views: 9000,
        likes: 450,
        comments: 60,
      });
      // Video views feed the content bucket; likes/comments are shown in the
      // main-content section but not summed into bucket engagements.
      expect(snap.reach.content).toEqual({ views: 9000, impressions: 0, engagements: 0 });
      expect(snap.reach.totals).toEqual({ views: 9000, impressions: 0, engagements: 0 });
      // The video is its own channel row: views + likes/comments as
      // engagement, impressions blank (YouTube has no impression metric here).
      expect(snap.byChannel).toEqual([
        { platform: "youtube", impressions: null, clicks: 0, engagements: 510, views: 9000 },
      ]);
    });

    test("YouTube mainContent is null when the loader returns unconfigured/error", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: {
          campaignId: "C1",
          name: "Video push",
          status: "active",
          deliverableType: "youtube",
          youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
        },
        socialPosts: [],
        contentPosts: [],
      });
      youtubeService.loadCampaignYoutube.mockResolvedValue({
        configured: false,
        error: null,
        youtube_url: "https://youtu.be/dQw4w9WgXcQ",
        video_id: "dQw4w9WgXcQ",
      });
      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.mainContent).toBeNull();
    });

    test("posts split into views/impressions/engagements + top metric, sorted by engagement desc", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: { campaignId: "C1", name: "x", status: "active" },
        socialPosts: [
          {
            platform: "twitter", url: "https://t.co/a", notes: "n",
            analytics: { likes: 5, retweets: 2 }, lastFetched: "2026-03-02T10:00:00.000Z",
          },
          {
            platform: "linkedin", url: "https://li/b", notes: null,
            analytics: { reactions: 30, comments: 4, impressions: 900 }, lastFetched: null,
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
      // LinkedIn engagements (reactions 30 + comments 4 = 34, impressions excluded)
      // ahead of twitter (5 + 2 = 7).
      expect(snap.socialPosts).toEqual([
        {
          platform: "linkedin", url: "https://li/b", notes: null,
          views: 0, impressions: 900, engagements: 34,
          topMetric: "impressions", topMetricValue: 900, lastFetched: null,
        },
        {
          platform: "twitter", url: "https://t.co/a", notes: "n",
          views: 0, impressions: 0, engagements: 7,
          topMetric: "likes", topMetricValue: 5, lastFetched: "2026-03-02T10:00:00.000Z",
        },
      ]);
      // Medium: views key -> views, reads -> engagement.
      expect(snap.contentPosts).toEqual([
        {
          platform: "medium", url: "https://m/x", notes: null,
          views: 800, impressions: 0, engagements: 200,
          topMetric: "views", topMetricValue: 800, lastFetched: "2026-03-03T10:00:00.000Z",
        },
      ]);
      // Buckets: content = cross-posts (no GA4 here); social = social posts.
      expect(snap.reach).toEqual({
        content: { views: 800, impressions: 0, engagements: 200 },
        social: { views: 0, impressions: 900, engagements: 41 },
        totals: { views: 800, impressions: 900, engagements: 241 },
      });
    });

    test("byChannel breaks placements out with per-metric availability + click attribution", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: { campaignId: "C1", name: "x", status: "active" },
        socialPosts: [
          { platform: "linkedin", url: "https://li/a", analytics: { reactions: 30, comments: 4, impressions: 900 }, lastFetched: null },
          { platform: "twitter", url: "https://t.co/a", analytics: { likes: 10, views: 500 }, lastFetched: null },
          { platform: "bluesky", url: "https://bsky/a", analytics: { likes: 7, reposts: 3 }, lastFetched: null },
        ],
        contentPosts: [
          { platform: "medium", url: "https://m/a", analytics: { views: 800, reads: 200, impressions: 1200, claps: 50 }, lastFetched: null },
        ],
      });
      ga4Service.loadCampaignGa4.mockResolvedValue({
        configured: true,
        error: null,
        blog_url: "https://blog/p",
        range: { startDate: "2026-03-01", endDate: "2026-03-28" },
        totals: { pageviews: 1500, users: 1000, sessions: 1200, avg_session_duration: 100, engagement_rate: 0.5 },
      });
      analyticsService.getCampaignAnalytics.mockResolvedValue(analytics({
        total_clicks: 60,
        by_platform: { linkedin: 20, twitter: 15, blog: 25 },
        links: [
          // main-role link clicks roll into the featured "blog" channel, not a
          // separate "blog"-platform distribution row.
          { url: "https://blog/p", role: "main", platform: "blog", total_clicks: 25 },
          { url: "https://li/a", role: "social_promo", platform: "linkedin", total_clicks: 20 },
          { url: "https://t.co/a", role: "social_promo", platform: "twitter", total_clicks: 15 },
        ],
      }));

      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      const byKey = Object.fromEntries(snap.byChannel.map((c) => [c.platform, c]));

      // LinkedIn: reports impressions, never a views key -> views blank.
      expect(byKey.linkedin).toEqual({ platform: "linkedin", impressions: 900, clicks: 20, engagements: 34, views: null });
      // X/Twitter: reports views, never an impressions key -> impressions blank.
      expect(byKey.twitter).toEqual({ platform: "twitter", impressions: null, clicks: 15, engagements: 10, views: 500 });
      // Bluesky: engagements only; no impressions, no views, no tracked link.
      expect(byKey.bluesky).toEqual({ platform: "bluesky", impressions: null, clicks: 0, engagements: 10, views: null });
      // Medium: reports both views and impressions distinctly (reads + claps -> engagements).
      expect(byKey.medium).toEqual({ platform: "medium", impressions: 1200, clicks: 0, engagements: 250, views: 800 });
      // Blog (featured): GA4 pageviews as views, no impression concept, engagement is a rate (blank here), main-link clicks.
      expect(byKey.blog).toEqual({ platform: "blog", impressions: null, clicks: 25, engagements: null, views: 1500 });

      // Sorted by total reach (impressions + views) desc.
      expect(snap.byChannel.map((c) => c.platform)).toEqual(["medium", "blog", "linkedin", "twitter", "bluesky"]);
    });

    test("posts with no analytics map to zero views/impressions/engagements, null top metric", async () => {
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
        views: 0, impressions: 0, engagements: 0,
        topMetric: null, topMetricValue: 0, lastFetched: null,
      });
      // A post with no synced analytics and no tracked clicks contributes no
      // channel row — nothing to show beats a row of all dashes.
      expect(snap.byChannel).toEqual([]);
    });

    test("zero total clicks -> shares are 0, reach totals zero", async () => {
      analyticsService.getCampaignAnalytics.mockResolvedValue(analytics({
        total_clicks: 0,
        by_src: { nl: 0 },
        links: [
          { url: "https://a", short_url: null, role: "primary", platform: "newsletter", total_clicks: 0, first_click_at: null, last_click_at: null },
        ],
      }));
      const snap = await buildCampaignReportSnapshot({ campaignId: "C1" });
      expect(snap.bySrc).toEqual([{ source: "nl", clicks: 0, share: 0 }]);
      expect(snap.reach.totals).toEqual({ views: 0, impressions: 0, engagements: 0 });
    });
  });
});
