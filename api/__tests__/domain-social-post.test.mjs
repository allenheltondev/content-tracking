import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");

// Mock the campaign domain so social-post tests don't reach into campaign
// reads / the GSI. We only need findCampaign + listActiveCampaigns.
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  findCampaign: jest.fn(),
  listActiveCampaigns: jest.fn(),
}));

const campaignDomain = await import("../domain/campaign.mjs");
const {
  createSocialPost,
  listSocialPosts,
  findSocialPost,
  updateSocialPostAnalytics,
  deleteSocialPost,
  listActiveCampaignSocialPosts,
} = await import("../domain/social-post.mjs");

describe("domain/social-post", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
    campaignDomain.findCampaign.mockReset();
    campaignDomain.listActiveCampaigns.mockReset();
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
    test("queries the campaign partition with the SOCIALPOST prefix", async () => {
      mockSend.mockResolvedValueOnce({ Items: [{ postId: "P1" }] });
      const items = await listSocialPosts("C1");
      expect(items).toHaveLength(1);
      const input = mockSend.mock.calls[0][0].input;
      expect(input.ExpressionAttributeValues[":pk"]).toBe("CAMPAIGN#C1");
      expect(input.ExpressionAttributeValues[":prefix"]).toBe("SOCIALPOST#");
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
      mockSend.mockResolvedValueOnce({ Attributes: { postId: "P1", lastFetched: "x" } });
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
      mockSend.mockResolvedValueOnce({ Attributes: { postId: "P1" } });
      await updateSocialPostAnalytics("C1", "P1", { metrics: { likes: 5 } });
      const input = mockSend.mock.calls[0][0].input;
      expect(input.UpdateExpression).not.toMatch(/capturedAt/);
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
