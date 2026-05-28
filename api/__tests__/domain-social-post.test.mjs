import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");

// Mock the campaign and link domains so social-post tests don't reach into
// campaign reads / the GSI. We only need findCampaign + status-bucketed
// campaign listings + a campaign-link listing.
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  findCampaign: jest.fn(),
  listActiveCampaigns: jest.fn(),
  listCampaignsByStatus: jest.fn(),
}));
jest.unstable_mockModule("../domain/link.mjs", () => ({
  listCampaignLinks: jest.fn(),
}));

const campaignDomain = await import("../domain/campaign.mjs");
const linkDomain = await import("../domain/link.mjs");
const {
  createSocialPost,
  listSocialPosts,
  findSocialPost,
  updateSocialPostAnalytics,
  deleteSocialPost,
  listActiveCampaignSocialPosts,
  listMonitoringWorkingSet,
  listSocialPostSnapshots,
} = await import("../domain/social-post.mjs");

describe("domain/social-post", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
    campaignDomain.findCampaign.mockReset();
    campaignDomain.listActiveCampaigns.mockReset();
    campaignDomain.listCampaignsByStatus.mockReset();
    linkDomain.listCampaignLinks.mockReset();
  });

  describe("createSocialPost", () => {
    test("404 when campaign doesn't exist", async () => {
      campaignDomain.findCampaign.mockResolvedValueOnce(null);
      await expect(
        createSocialPost("C1", { platform: "twitter", url: "https://x.com/a/status/1" }),
      ).rejects.toThrow(/Campaign C1 not found/);
    });

    test("writes the social post item under the campaign partition", async () => {
      campaignDomain.findCampaign.mockResolvedValueOnce({ campaignId: "C1" });
      mockSend.mockResolvedValueOnce({}); // PutItem

      const item = await createSocialPost("C1", {
        platform: "twitter",
        url: "https://x.com/a/status/1",
        notes: "hero",
      });

      expect(item.postId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(item.pk).toBe("CAMPAIGN#C1");
      expect(item.sk).toBe(`SOCIALPOST#${item.postId}`);
      expect(item.platform).toBe("twitter");
      expect(item.notes).toBe("hero");
      const input = mockSend.mock.calls[0][0].input;
      expect(input.ConditionExpression).toBe("attribute_not_exists(sk)");
    });
  });

  describe("listSocialPosts", () => {
    test("queries the campaign partition with the SOCIALPOST prefix, filtering out snapshots", async () => {
      mockSend.mockResolvedValueOnce({ Items: [{ postId: "P1" }] });
      const items = await listSocialPosts("C1");
      expect(items).toHaveLength(1);
      const input = mockSend.mock.calls[0][0].input;
      expect(input.ExpressionAttributeValues[":pk"]).toBe("CAMPAIGN#C1");
      expect(input.ExpressionAttributeValues[":prefix"]).toBe("SOCIALPOST#");
      // Snapshot rows share the SOCIALPOST# sk prefix; filter on entity so
      // they never come back as posts.
      expect(input.FilterExpression).toBe("#entity = :entity");
      expect(input.ExpressionAttributeNames["#entity"]).toBe("entity");
      expect(input.ExpressionAttributeValues[":entity"]).toBe("SocialPost");
    });
  });

  describe("findSocialPost", () => {
    test("returns null when missing", async () => {
      mockSend.mockResolvedValueOnce({});
      expect(await findSocialPost("C1", "P1")).toBeNull();
    });
  });

  describe("updateSocialPostAnalytics", () => {
    test("sets analytics + lastFetched and returns the new item", async () => {
      mockSend
        .mockResolvedValueOnce({ Attributes: { postId: "P1", lastFetched: "x" } })
        .mockResolvedValueOnce({}); // snapshot Put
      const out = await updateSocialPostAnalytics("C1", "P1", {
        metrics: { likes: 5 },
        capturedAt: "2026-05-27T00:00:00.000Z",
      });
      expect(out.postId).toBe("P1");
      const input = mockSend.mock.calls[0][0].input;
      expect(input.UpdateExpression).toMatch(/#analytics = :analytics/);
      expect(input.UpdateExpression).toMatch(/#lastFetched = :lastFetched/);
      expect(input.UpdateExpression).toMatch(/#capturedAt = :capturedAt/);
      expect(input.ExpressionAttributeValues[":analytics"]).toEqual({ likes: 5 });
      expect(input.ConditionExpression).toBe("attribute_exists(sk)");
    });

    test("omits capturedAt clause when not supplied", async () => {
      mockSend
        .mockResolvedValueOnce({ Attributes: { postId: "P1" } })
        .mockResolvedValueOnce({}); // snapshot Put
      await updateSocialPostAnalytics("C1", "P1", { metrics: { likes: 5 } });
      const input = mockSend.mock.calls[0][0].input;
      expect(input.UpdateExpression).not.toMatch(/capturedAt/);
    });

    test("writes a per-day snapshot keyed by the capturedAt date", async () => {
      mockSend
        .mockResolvedValueOnce({ Attributes: { postId: "P1" } })
        .mockResolvedValueOnce({});
      await updateSocialPostAnalytics("C1", "P1", {
        metrics: { likes: 5, comments: 2 },
        capturedAt: "2026-05-27T15:30:00.000Z",
      });
      const snapshotInput = mockSend.mock.calls[1][0].input;
      expect(snapshotInput.Item.pk).toBe("CAMPAIGN#C1");
      expect(snapshotInput.Item.sk).toBe("SOCIALPOST#P1#SNAPSHOT#2026-05-27");
      expect(snapshotInput.Item.entity).toBe("SocialPostSnapshot");
      expect(snapshotInput.Item.snapshotDate).toBe("2026-05-27");
      expect(snapshotInput.Item.metrics).toEqual({ likes: 5, comments: 2 });
      expect(snapshotInput.Item.capturedAt).toBe("2026-05-27T15:30:00.000Z");
    });

    test("404 on ConditionalCheckFailed", async () => {
      const err = new Error();
      err.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValueOnce(err);
      await expect(
        updateSocialPostAnalytics("C1", "P1", { metrics: { likes: 1 } }),
      ).rejects.toThrow(/SocialPost P1 not found/);
    });
  });

  describe("listSocialPostSnapshots", () => {
    test("queries the SNAPSHOT prefix for the post and sorts ascending", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          { snapshotDate: "2026-05-28", metrics: { likes: 7 } },
          { snapshotDate: "2026-05-27", metrics: { likes: 5 } },
        ],
      });
      const out = await listSocialPostSnapshots("C1", "P1");
      expect(out.map((s) => s.snapshotDate)).toEqual(["2026-05-27", "2026-05-28"]);
      const input = mockSend.mock.calls[0][0].input;
      expect(input.ExpressionAttributeValues[":pk"]).toBe("CAMPAIGN#C1");
      expect(input.ExpressionAttributeValues[":prefix"]).toBe("SOCIALPOST#P1#SNAPSHOT#");
    });
  });

  describe("listMonitoringWorkingSet", () => {
    test("fans out posts + cross-post links for each monitoring campaign", async () => {
      campaignDomain.listCampaignsByStatus.mockResolvedValueOnce([
        { campaignId: "C1", name: "One" },
      ]);
      linkDomain.listCampaignLinks.mockResolvedValueOnce([
        { linkId: "L1", role: "cross_post", campaignId: "C1" },
        { linkId: "L2", role: "social_promo", campaignId: "C1" },
      ]);
      mockSend.mockResolvedValueOnce({ Items: [{ postId: "P1", campaignId: "C1" }] });

      const out = await listMonitoringWorkingSet();
      expect(campaignDomain.listCampaignsByStatus).toHaveBeenCalledWith("monitoring");
      expect(out.socialPosts).toHaveLength(1);
      expect(out.socialPosts[0].post.postId).toBe("P1");
      expect(out.crossPostLinks).toHaveLength(1);
      expect(out.crossPostLinks[0].link.linkId).toBe("L1");
    });
  });

  describe("deleteSocialPost", () => {
    test("404 when missing", async () => {
      const err = new Error();
      err.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValueOnce(err);
      await expect(deleteSocialPost("C1", "P1")).rejects.toThrow(/SocialPost P1 not found/);
    });

    test("deletes when present", async () => {
      mockSend.mockResolvedValueOnce({});
      await deleteSocialPost("C1", "P1");
      expect(mockSend.mock.calls[0][0].input.Key).toEqual({
        pk: "CAMPAIGN#C1",
        sk: "SOCIALPOST#P1",
      });
    });
  });

  describe("listActiveCampaignSocialPosts", () => {
    test("fans out one query per active campaign and flattens", async () => {
      campaignDomain.listActiveCampaigns.mockResolvedValueOnce([
        { campaignId: "C1", name: "One" },
        { campaignId: "C2", name: "Two" },
      ]);
      mockSend
        .mockResolvedValueOnce({ Items: [{ postId: "P1", campaignId: "C1" }] })
        .mockResolvedValueOnce({ Items: [{ postId: "P2", campaignId: "C2" }] });

      const rows = await listActiveCampaignSocialPosts();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.post.postId).sort()).toEqual(["P1", "P2"]);
      expect(rows.every((r) => r.campaign.name)).toBe(true);
    });
  });
});
