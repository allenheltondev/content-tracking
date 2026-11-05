import { jest } from "@jest/globals";

jest.unstable_mockModule("../services/ga-secrets.mjs", () => ({ readCruxApiKey: jest.fn() }));
jest.unstable_mockModule("../services/ga4.mjs", () => ({
  defaultGa4Range: () => ({ startDate: "2026-10-09", endDate: "2026-11-05" }),
  loadGa4Section: jest.fn(),
}));
jest.unstable_mockModule("../services/core-web-vitals.mjs", () => ({ fetchWebVitals: jest.fn() }));
jest.unstable_mockModule("../services/campaign-youtube.mjs", () => ({ loadCampaignYoutube: jest.fn() }));

const { readCruxApiKey } = await import("../services/ga-secrets.mjs");
const { loadGa4Section } = await import("../services/ga4.mjs");
const { fetchWebVitals } = await import("../services/core-web-vitals.mjs");
const { loadCampaignYoutube } = await import("../services/campaign-youtube.mjs");
const { loadCampaignWebAnalytics } = await import("../services/campaign-web-analytics.mjs");

const blog = { campaignId: "C1", blogUrl: "https://example.com/posts/launch" };

beforeEach(() => {
  jest.resetAllMocks();
  loadGa4Section.mockResolvedValue({ configured: true, sessions: 10 });
});

describe("loadCampaignWebAnalytics", () => {
  test("blog: GA4 on the URL path over the default range, vitals marked unconfigured without a key", async () => {
    readCruxApiKey.mockResolvedValue(null);
    const out = await loadCampaignWebAnalytics(blog);
    expect(loadGa4Section).toHaveBeenCalledWith({
      pagePath: "/posts/launch",
      startDate: "2026-10-09",
      endDate: "2026-11-05",
    });
    expect(out).toMatchObject({
      campaign_id: "C1",
      deliverable_type: "blog",
      range: { startDate: "2026-10-09", endDate: "2026-11-05" },
      core_web_vitals: { configured: false, error: null },
    });
  });

  test("blog: a vitals failure is reported inline", async () => {
    readCruxApiKey.mockResolvedValue("key");
    fetchWebVitals.mockRejectedValue(new Error("crux down"));
    const out = await loadCampaignWebAnalytics(blog, { startDate: "2026-10-01", endDate: "2026-10-31" });
    expect(out.core_web_vitals).toEqual({ configured: true, error: "crux down" });
    expect(out.range).toEqual({ startDate: "2026-10-01", endDate: "2026-10-31" });
  });

  test("rejects an inverted range and a campaign with no blog URL", async () => {
    await expect(
      loadCampaignWebAnalytics(blog, { startDate: "2026-11-02", endDate: "2026-11-01" }),
    ).rejects.toThrow(/must not be after/);
    await expect(loadCampaignWebAnalytics({ campaignId: "C1" })).rejects.toThrow(/no blogUrl/);
  });

  test("youtube: returns video stats and requires a URL", async () => {
    loadCampaignYoutube.mockResolvedValue({ views: 100 });
    const yt = { campaignId: "C2", deliverableType: "youtube", youtubeUrl: "https://youtu.be/abc" };
    await expect(loadCampaignWebAnalytics(yt)).resolves.toEqual({
      campaign_id: "C2",
      deliverable_type: "youtube",
      youtube: { views: 100 },
    });
    await expect(
      loadCampaignWebAnalytics({ campaignId: "C2", deliverableType: "youtube" }),
    ).rejects.toThrow(/no youtube_url/);
  });
});
