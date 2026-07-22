import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  listAllCampaigns: jest.fn(),
}));
jest.unstable_mockModule("../domain/social-post.mjs", () => ({
  listSocialPosts: jest.fn(),
  listSocialPostSnapshots: jest.fn(),
}));
jest.unstable_mockModule("../domain/content-post.mjs", () => ({
  listContentPosts: jest.fn(),
  listContentPostSnapshots: jest.fn(),
}));

const { listAllCampaigns } = await import("../domain/campaign.mjs");
const { listSocialPosts, listSocialPostSnapshots } = await import("../domain/social-post.mjs");
const { listContentPosts, listContentPostSnapshots } = await import("../domain/content-post.mjs");
const { buildInsightsSummary } = await import("../domain/insights.mjs");

function snap(date, metrics) {
  return { snapshotDate: date, metrics };
}

describe("buildInsightsSummary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listContentPosts.mockResolvedValue([]);
    listContentPostSnapshots.mockResolvedValue([]);
  });

  test("carries cumulative levels forward across gaps in the window", async () => {
    listAllCampaigns.mockResolvedValue([{ campaignId: "C1", name: "Launch", status: "active" }]);
    listSocialPosts.mockResolvedValue([{ campaignId: "C1", postId: "P1", platform: "x", url: "u" }]);
    // Captured on the 1st and the 3rd; the 2nd has no snapshot.
    listSocialPostSnapshots.mockResolvedValue([
      snap("2026-01-01", { likes: 10, views: 100 }),
      snap("2026-01-03", { likes: 25, views: 300 }),
    ]);

    const out = await buildInsightsSummary({ startDate: "2026-01-01", endDate: "2026-01-03" });

    expect(out.timeseries).toEqual([
      { date: "2026-01-01", views: 100, impressions: 0, engagements: 10 },
      // Day 2 carries forward the 1st's level (not zero, not the 3rd's).
      { date: "2026-01-02", views: 100, impressions: 0, engagements: 10 },
      { date: "2026-01-03", views: 300, impressions: 0, engagements: 25 },
    ]);
    expect(out.range).toEqual({ startDate: "2026-01-01", endDate: "2026-01-03", days: 3 });
  });

  test("seeds carry-in from a snapshot before the window start", async () => {
    listAllCampaigns.mockResolvedValue([{ campaignId: "C1", name: "Launch", status: "active" }]);
    listSocialPosts.mockResolvedValue([{ campaignId: "C1", postId: "P1", platform: "x", url: "u" }]);
    listSocialPostSnapshots.mockResolvedValue([
      snap("2025-12-20", { likes: 5, impressions: 50 }),
    ]);

    const out = await buildInsightsSummary({ startDate: "2026-01-01", endDate: "2026-01-02" });

    // Both in-window days reflect the pre-window level carried in.
    expect(out.timeseries).toEqual([
      { date: "2026-01-01", views: 0, impressions: 50, engagements: 5 },
      { date: "2026-01-02", views: 0, impressions: 50, engagements: 5 },
    ]);
  });

  test("sums across posts and content, ranks top performers, splits by platform", async () => {
    listAllCampaigns.mockResolvedValue([{ campaignId: "C1", name: "Launch", status: "completed" }]);
    listSocialPosts.mockResolvedValue([
      { campaignId: "C1", postId: "P1", platform: "x", url: "x-url" },
      { campaignId: "C1", postId: "P2", platform: "linkedin", url: "li-url" },
    ]);
    listContentPosts.mockResolvedValue([
      { campaignId: "C1", postId: "P3", platform: "medium", url: "md-url" },
    ]);
    listSocialPostSnapshots.mockImplementation((_c, pid) =>
      Promise.resolve(
        pid === "P1"
          ? [snap("2026-01-02", { likes: 50, views: 1000 })]
          : [snap("2026-01-02", { reactions: 5, impressions: 200 })],
      ),
    );
    listContentPostSnapshots.mockResolvedValue([snap("2026-01-02", { claps: 30, views: 500 })]);

    const out = await buildInsightsSummary({ startDate: "2026-01-01", endDate: "2026-01-03" });

    expect(out.totals.engagements).toBe(85); // 50 + 5 + 30
    expect(out.totals.reach).toBe(1700); // views 1500 + impressions 200
    expect(out.totals.postsTracked).toBe(3);
    // Top performer is P1 (50 engagements).
    expect(out.topPosts[0]).toMatchObject({ url: "x-url", engagements: 50, campaignName: "Launch" });
    expect(out.byPlatform.map((p) => p.platform)).toEqual(
      expect.arrayContaining(["x", "linkedin", "medium"]),
    );
  });

  test("computes period-over-period gain and percent change", async () => {
    listAllCampaigns.mockResolvedValue([{ campaignId: "C1", name: "Launch", status: "active" }]);
    listSocialPosts.mockResolvedValue([{ campaignId: "C1", postId: "P1", platform: "x", url: "u" }]);
    // 2-day window 01-03..01-04. Prior period is 01-01..01-02.
    // Level before prior (12-31): none -> 0. Before window (01-02): 10.
    // End (01-04): 30. Gain this period = 30-10 = 20; prior = 10-0 = 10.
    listSocialPostSnapshots.mockResolvedValue([
      snap("2026-01-02", { likes: 10 }),
      snap("2026-01-04", { likes: 30 }),
    ]);

    const out = await buildInsightsSummary({ startDate: "2026-01-03", endDate: "2026-01-04" });

    expect(out.deltas.thisPeriod.engagements).toBe(20);
    expect(out.deltas.priorPeriod.engagements).toBe(10);
    expect(out.deltas.changePct.engagements).toBeCloseTo(1.0, 6); // (20-10)/10
  });

  test("empty account yields zeroed totals and a full zero series", async () => {
    listAllCampaigns.mockResolvedValue([]);

    const out = await buildInsightsSummary({ startDate: "2026-01-01", endDate: "2026-01-02" });

    expect(out.totals).toMatchObject({
      views: 0,
      impressions: 0,
      engagements: 0,
      reach: 0,
      engagementRate: null,
      postsTracked: 0,
    });
    expect(out.timeseries).toEqual([
      { date: "2026-01-01", views: 0, impressions: 0, engagements: 0 },
      { date: "2026-01-02", views: 0, impressions: 0, engagements: 0 },
    ]);
    expect(out.topPosts).toEqual([]);
    expect(out.deltas.changePct.engagements).toBeNull();
  });

  test("fans out to every campaign in the list", async () => {
    listAllCampaigns.mockResolvedValue([
      { campaignId: "C1", name: "A", status: "active" },
      { campaignId: "C2", name: "B", status: "active" },
    ]);
    listSocialPosts.mockResolvedValue([]);

    await buildInsightsSummary({ startDate: "2026-01-01", endDate: "2026-01-02" });

    expect(listSocialPosts).toHaveBeenCalledWith("C1");
    expect(listSocialPosts).toHaveBeenCalledWith("C2");
    expect(listContentPosts).toHaveBeenCalledWith("C1");
    expect(listContentPosts).toHaveBeenCalledWith("C2");
  });
});
