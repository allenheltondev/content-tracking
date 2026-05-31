import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

// Mock every collaborator so the aggregation logic is exercised in isolation.
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  listCampaigns: jest.fn(),
}));
jest.unstable_mockModule("../domain/social-post.mjs", () => ({
  listSocialPosts: jest.fn(),
}));
jest.unstable_mockModule("../domain/content-post.mjs", () => ({
  listContentPosts: jest.fn(),
}));
jest.unstable_mockModule("../domain/profile.mjs", () => ({
  getProfileSettings: jest.fn(),
}));
jest.unstable_mockModule("../services/profile-assets.mjs", () => ({
  signProfileAssetUrl: jest.fn(),
}));

const { listCampaigns } = await import("../domain/campaign.mjs");
const { listSocialPosts } = await import("../domain/social-post.mjs");
const { listContentPosts } = await import("../domain/content-post.mjs");
const { getProfileSettings } = await import("../domain/profile.mjs");
const { signProfileAssetUrl } = await import("../services/profile-assets.mjs");
const { buildMediaKitSnapshot } = await import("../domain/media-kit.mjs");

const FULL_PROFILE = {
  brandName: "Ready, Set, Cloud!",
  websiteUrl: "https://readysetcloud.io",
  displayName: "Allen Helton",
  tagline: "Serverless educator",
  bio: "I teach cloud.",
  location: "Tennessee, USA",
  contactEmail: "allen@example.com",
  accentColor: "#1a2b3c",
  niches: ["AWS", "Serverless"],
  avatarKey: "profile/avatar-01HZX7M6Z5GQK6T7Q8N9R0P1V2.png",
  logoKey: "profile/logo-01HZX7M6Z5GQK6T7Q8N9R0P1V3.png",
  socialAccounts: [
    { platform: "x", handle: "@allen", url: null, followers: 12000 },
    { platform: "youtube", handle: null, url: "https://youtube.com/@allen", followers: 3000 },
  ],
  audience: { ageBrackets: { "25-34": 45 } },
  rateCard: [{ deliverable: "Sponsored post", description: null, price: 2500, currency: "USD" }],
  testimonials: [{ quote: "Great", author: "Jordan", role: null, company: null }],
  featuredCollaborations: [{ brand: "Acme", description: null, url: null, year: 2025 }],
};

describe("buildMediaKitSnapshot", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    signProfileAssetUrl.mockImplementation((key) => ({
      url: `https://cdn.example.com/${key}?sig`,
      expiresAt: "2026-09-01T00:00:00.000Z",
    }));
  });

  test("aggregates followers, reach, engagement, and campaign counts", async () => {
    getProfileSettings.mockResolvedValue(FULL_PROFILE);
    listCampaigns.mockResolvedValue({
      items: [
        { campaignId: "C1", status: "completed" },
        { campaignId: "C2", status: "active" },
      ],
      lastEvaluatedKey: undefined,
    });
    listSocialPosts.mockImplementation((id) =>
      Promise.resolve(
        id === "C1"
          ? [{ analytics: { likes: 50, reposts: 10, views: 1000, impressions: 2000 } }]
          : [{ analytics: { likes: 5, views: 100 } }],
      ),
    );
    listContentPosts.mockImplementation((id) =>
      Promise.resolve(
        id === "C1" ? [{ analytics: { claps: 30, views: 500 } }] : [],
      ),
    );

    const snap = await buildMediaKitSnapshot({ assetUrlTtlSeconds: 1000 });

    expect(snap.stats.totalFollowers).toBe(15000);
    expect(snap.stats.platformCount).toBe(2);
    expect(snap.stats.campaignsCompleted).toBe(1);
    expect(snap.stats.campaignsTotal).toBe(2);
    expect(snap.stats.postsTracked).toBe(3);
    // views: 1000 + 100 + 500 = 1600; impressions: 2000; reach = 3600
    expect(snap.stats.totalViews).toBe(1600);
    expect(snap.stats.totalImpressions).toBe(2000);
    expect(snap.stats.totalReach).toBe(3600);
    // engagements: (50+10) + 5 + 30 = 95
    expect(snap.stats.totalEngagements).toBe(95);
    expect(snap.stats.engagementRate).toBeCloseTo(95 / 3600, 6);
  });

  test("maps identity and signs avatar/logo for the requested ttl", async () => {
    getProfileSettings.mockResolvedValue(FULL_PROFILE);
    listCampaigns.mockResolvedValue({ items: [], lastEvaluatedKey: undefined });
    listSocialPosts.mockResolvedValue([]);
    listContentPosts.mockResolvedValue([]);

    const snap = await buildMediaKitSnapshot({ assetUrlTtlSeconds: 7777 });

    expect(snap.report.kind).toBe("media-kit");
    expect(snap.identity.displayName).toBe("Allen Helton");
    expect(snap.identity.niches).toEqual(["AWS", "Serverless"]);
    expect(snap.identity.avatarUrl).toBe(
      "https://cdn.example.com/profile/avatar-01HZX7M6Z5GQK6T7Q8N9R0P1V2.png?sig",
    );
    expect(signProfileAssetUrl).toHaveBeenCalledWith(FULL_PROFILE.avatarKey, {
      expiresInSeconds: 7777,
    });
    expect(snap.brand).toEqual({ name: "Ready, Set, Cloud!", websiteUrl: "https://readysetcloud.io" });
    expect(snap.rateCard).toHaveLength(1);
    expect(snap.testimonials).toHaveLength(1);
    expect(snap.featuredCollaborations).toHaveLength(1);
  });

  test("paginates through every campaign page", async () => {
    getProfileSettings.mockResolvedValue({});
    listCampaigns
      .mockResolvedValueOnce({ items: [{ campaignId: "C1", status: "completed" }], lastEvaluatedKey: { k: 1 } })
      .mockResolvedValueOnce({ items: [{ campaignId: "C2", status: "completed" }], lastEvaluatedKey: undefined });
    listSocialPosts.mockResolvedValue([]);
    listContentPosts.mockResolvedValue([]);

    const snap = await buildMediaKitSnapshot();

    expect(listCampaigns).toHaveBeenCalledTimes(2);
    expect(snap.stats.campaignsTotal).toBe(2);
    expect(snap.stats.campaignsCompleted).toBe(2);
  });

  test("empty profile yields zeroed stats and null engagement rate", async () => {
    getProfileSettings.mockResolvedValue(null);
    listCampaigns.mockResolvedValue({ items: [], lastEvaluatedKey: undefined });
    listSocialPosts.mockResolvedValue([]);
    listContentPosts.mockResolvedValue([]);

    const snap = await buildMediaKitSnapshot();

    expect(snap.stats).toMatchObject({
      totalFollowers: 0,
      platformCount: 0,
      campaignsCompleted: 0,
      campaignsTotal: 0,
      postsTracked: 0,
      totalReach: 0,
      totalEngagements: 0,
      engagementRate: null,
    });
    expect(snap.brand).toBeNull();
    expect(snap.identity.avatarUrl).toBeNull();
    expect(signProfileAssetUrl).not.toHaveBeenCalled();
  });

  test("a signing failure degrades the asset url to null", async () => {
    getProfileSettings.mockResolvedValue({ avatarKey: "profile/avatar-01HZX7M6Z5GQK6T7Q8N9R0P1V2.png" });
    listCampaigns.mockResolvedValue({ items: [], lastEvaluatedKey: undefined });
    listSocialPosts.mockResolvedValue([]);
    listContentPosts.mockResolvedValue([]);
    signProfileAssetUrl.mockImplementation(() => {
      throw new Error("no cloudfront key");
    });

    const snap = await buildMediaKitSnapshot();
    expect(snap.identity.avatarUrl).toBeNull();
  });
});
