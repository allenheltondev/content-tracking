import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

// Mock the campaign domain + newsletter-service client so the aggregation
// is exercised in isolation (no DynamoDB, no HTTP). Matches the
// unstable_mockModule idiom used by the other tests.
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  getCampaignWithLinks: jest.fn(),
}));
jest.unstable_mockModule("../services/newsletter-service.mjs", () => ({
  fetchLinkAnalytics: jest.fn(),
  fetchCampaignLinksAnalytics: jest.fn(),
}));

const campaignDomain = await import("../domain/campaign.mjs");
const newsletterService = await import("../services/newsletter-service.mjs");
const { UpstreamError } = await import("../services/errors.mjs");
const { getCampaignAnalytics } = await import("../services/campaign-analytics.mjs");

function localLink(overrides = {}) {
  return {
    linkId: "L1",
    code: "abc",
    shortUrl: "https://s.test/abc",
    role: "primary",
    platform: "newsletter",
    url: "https://example.test/p",
    src: "nl",
    ...overrides,
  };
}

describe("services/campaign-analytics getCampaignAnalytics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    campaignDomain.getCampaignWithLinks.mockReset();
    newsletterService.fetchLinkAnalytics.mockReset();
    newsletterService.fetchCampaignLinksAnalytics.mockReset();
  });

  describe("linkTrackingId (single-call) path", () => {
    test("joins upstream links on code and aggregates", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: { campaignId: "C1", linkTrackingId: "T1" },
        links: [
          localLink({ linkId: "L1", code: "abc", role: "primary", platform: "newsletter" }),
          localLink({ linkId: "L2", code: "def", role: "secondary", platform: "twitter" }),
        ],
      });
      newsletterService.fetchCampaignLinksAnalytics.mockResolvedValue({
        links: [
          {
            code: "abc",
            url: "https://up/abc",
            src: "nl",
            analytics: {
              total_clicks: 10,
              by_day: { "2026-01-01": 6, "2026-01-02": 4 },
              by_src: { nl: 10 },
              first_click_at: "2026-01-01T08:00:00.000Z",
              last_click_at: "2026-01-02T18:00:00.000Z",
            },
          },
          {
            code: "def",
            analytics: {
              total_clicks: 5,
              by_day: { "2026-01-02": 5 },
              by_src: { tw: 5 },
              first_click_at: "2026-01-02T09:00:00.000Z",
              last_click_at: "2026-01-02T09:00:00.000Z",
            },
          },
          // upstream-only link the local store doesn't know about
          {
            code: "ghi",
            url: "https://up/ghi",
            analytics: { total_clicks: 2, by_src: { nl: 2 } },
          },
        ],
      });

      const result = await getCampaignAnalytics("C1");

      expect(result.campaign_id).toBe("C1");
      expect(result.link_count).toBe(3);
      expect(result.total_clicks).toBe(17);
      expect(result.by_role).toEqual({ primary: 10, secondary: 5 });
      expect(result.by_platform).toEqual({ newsletter: 10, twitter: 5 });
      expect(result.by_day).toEqual({ "2026-01-01": 6, "2026-01-02": 9 });
      expect(result.by_src).toEqual({ nl: 12, tw: 5 });
      expect(result.upstream_failures).toBe(0);

      const ghi = result.links.find((l) => l.code === "ghi");
      expect(ghi.role).toBeNull();
      expect(ghi.link_id).toBeNull();
      expect(newsletterService.fetchLinkAnalytics).not.toHaveBeenCalled();
    });

    test("upstream failure yields upstream_failures=1 and empty links", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: { campaignId: "C1", linkTrackingId: "T1" },
        links: [localLink(), localLink({ linkId: "L2", code: "def" })],
      });
      newsletterService.fetchCampaignLinksAnalytics.mockRejectedValue(
        new UpstreamError("boom", 503),
      );

      const result = await getCampaignAnalytics("C1");
      expect(result.link_count).toBe(2);
      expect(result.total_clicks).toBe(0);
      expect(result.upstream_failures).toBe(1);
      expect(result.links).toEqual([]);
    });

    test("non-UpstreamError propagates", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: { campaignId: "C1", linkTrackingId: "T1" },
        links: [localLink()],
      });
      newsletterService.fetchCampaignLinksAnalytics.mockRejectedValue(new Error("kaboom"));
      await expect(getCampaignAnalytics("C1")).rejects.toThrow(/kaboom/);
    });
  });

  describe("fanout path", () => {
    test("aggregates per-link analytics", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: { campaignId: "C1" },
        links: [
          localLink({ linkId: "L1", code: "abc", role: "primary", platform: "newsletter" }),
          localLink({ linkId: "L2", code: "def", role: "secondary", platform: "twitter" }),
        ],
      });
      newsletterService.fetchLinkAnalytics.mockImplementation(async (code) => {
        if (code === "abc") {
          return {
            total_clicks: 8,
            by_day: { "2026-01-01": 8 },
            by_src: { nl: 8 },
            first_click_at: "2026-01-01T01:00:00.000Z",
            last_click_at: "2026-01-01T02:00:00.000Z",
          };
        }
        return {
          total_clicks: 3,
          by_day: { "2026-01-01": 3 },
          by_src: { tw: 3 },
          first_click_at: "2026-01-01T03:00:00.000Z",
          last_click_at: "2026-01-01T04:00:00.000Z",
        };
      });

      const result = await getCampaignAnalytics("C1");
      expect(result.link_count).toBe(2);
      expect(result.total_clicks).toBe(11);
      expect(result.by_role).toEqual({ primary: 8, secondary: 3 });
      expect(result.by_src).toEqual({ nl: 8, tw: 3 });
      expect(result.upstream_failures).toBe(0);
      expect(result.links.map((l) => l.code).sort()).toEqual(["abc", "def"]);
    });

    test("partial failure rolls into upstream_failures, keeps the good link", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: { campaignId: "C1" },
        links: [
          localLink({ linkId: "L1", code: "abc" }),
          localLink({ linkId: "L2", code: "def" }),
        ],
      });
      newsletterService.fetchLinkAnalytics.mockImplementation(async (code) => {
        if (code === "abc") return { total_clicks: 4, by_src: { nl: 4 } };
        throw new UpstreamError("nope", 502);
      });

      const result = await getCampaignAnalytics("C1");
      expect(result.upstream_failures).toBe(1);
      expect(result.total_clicks).toBe(4);
      const failed = result.links.find((l) => l.code === "def");
      expect(failed.error).toBeTruthy();
      expect(failed.total_clicks).toBe(0);
    });

    test("all calls failing returns upstream_failures === link_count (no throw)", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: { campaignId: "C1" },
        links: [
          localLink({ linkId: "L1", code: "abc" }),
          localLink({ linkId: "L2", code: "def" }),
        ],
      });
      newsletterService.fetchLinkAnalytics.mockRejectedValue(new UpstreamError("down", 503));

      const result = await getCampaignAnalytics("C1");
      expect(result.link_count).toBe(2);
      expect(result.upstream_failures).toBe(2);
      expect(result.total_clicks).toBe(0);
    });
  });

  describe("empty links", () => {
    test("returns a zeroed object", async () => {
      campaignDomain.getCampaignWithLinks.mockResolvedValue({
        metadata: { campaignId: "C1" },
        links: [],
      });
      const result = await getCampaignAnalytics("C1");
      expect(result).toEqual({
        campaign_id: "C1",
        link_count: 0,
        total_clicks: 0,
        by_role: {},
        by_platform: {},
        by_day: {},
        by_src: {},
        upstream_failures: 0,
        links: [],
      });
      expect(newsletterService.fetchLinkAnalytics).not.toHaveBeenCalled();
    });
  });
});
