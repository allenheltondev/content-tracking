import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");

// Mock the campaign domain so content-post tests stay focused on the
// content-post pk pattern.
jest.unstable_mockModule("../domain/campaign.mjs", () => ({
  findCampaign: jest.fn(),
  listCampaignsByStatus: jest.fn(),
}));

const campaignDomain = await import("../domain/campaign.mjs");
const {
  createContentPost,
  listContentPosts,
  findContentPost,
  updateContentPostAnalytics,
  deleteContentPost,
  listContentPostSnapshots,
  listMonitoringContentPosts,
} = await import("../domain/content-post.mjs");

describe("domain/content-post", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
    campaignDomain.findCampaign.mockReset();
    campaignDomain.listCampaignsByStatus.mockReset();
  });

  describe("createContentPost", () => {
    test("404 when campaign doesn't exist", async () => {
      campaignDomain.findCampaign.mockResolvedValueOnce(null);
      await expect(
        createContentPost("C1", { platform: "medium", url: "https://medium.com/@a/foo" }),
      ).rejects.toThrow(/Campaign C1 not found/);
    });

    test("writes the content post item under the campaign partition", async () => {
      campaignDomain.findCampaign.mockResolvedValueOnce({ campaignId: "C1" });
      mockSend.mockResolvedValueOnce({});

      const item = await createContentPost("C1", {
        platform: "medium",
        url: "https://medium.com/@a/foo-abc",
        notes: "cross-post",
      });

      expect(item.postId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(item.pk).toBe("CAMPAIGN#C1");
      expect(item.sk).toBe(`CONTENTPOST#${item.postId}`);
      expect(item.entity).toBe("ContentPost");
      expect(item.platform).toBe("medium");
      expect(item.notes).toBe("cross-post");
      const input = mockSend.mock.calls[0][0].input;
      expect(input.ConditionExpression).toBe("attribute_not_exists(sk)");
    });
  });

  describe("listContentPosts", () => {
    test("queries the campaign partition with the CONTENTPOST prefix, filtering snapshots out", async () => {
      mockSend.mockResolvedValueOnce({ Items: [{ postId: "P1" }] });
      const items = await listContentPosts("C1");
      expect(items).toHaveLength(1);
      const input = mockSend.mock.calls[0][0].input;
      expect(input.ExpressionAttributeValues[":pk"]).toBe("CAMPAIGN#C1");
      expect(input.ExpressionAttributeValues[":prefix"]).toBe("CONTENTPOST#");
      expect(input.FilterExpression).toBe("#entity = :entity");
      expect(input.ExpressionAttributeValues[":entity"]).toBe("ContentPost");
    });
  });

  describe("findContentPost", () => {
    test("returns null when missing", async () => {
      mockSend.mockResolvedValueOnce({});
      expect(await findContentPost("C1", "P1")).toBeNull();
    });
  });

  describe("updateContentPostAnalytics", () => {
    test("sets analytics + lastFetched and returns the new item", async () => {
      mockSend
        .mockResolvedValueOnce({ Attributes: { postId: "P1", lastFetched: "x" } })
        .mockResolvedValueOnce({}); // snapshot Put
      const out = await updateContentPostAnalytics("C1", "P1", {
        metrics: { views: 1200, claps: 80 },
        capturedAt: "2026-05-27T00:00:00.000Z",
      });
      expect(out.postId).toBe("P1");
      const input = mockSend.mock.calls[0][0].input;
      expect(input.UpdateExpression).toMatch(/#analytics = :analytics/);
      expect(input.UpdateExpression).toMatch(/#lastFetched = :lastFetched/);
      expect(input.UpdateExpression).toMatch(/#capturedAt = :capturedAt/);
      expect(input.ExpressionAttributeValues[":analytics"]).toEqual({ views: 1200, claps: 80 });
      expect(input.ConditionExpression).toBe("attribute_exists(sk)");
    });

    test("omits capturedAt clause when not supplied", async () => {
      mockSend
        .mockResolvedValueOnce({ Attributes: { postId: "P1" } })
        .mockResolvedValueOnce({});
      await updateContentPostAnalytics("C1", "P1", { metrics: { views: 1 } });
      const input = mockSend.mock.calls[0][0].input;
      expect(input.UpdateExpression).not.toMatch(/capturedAt/);
    });

    test("writes a per-day snapshot keyed by the capturedAt date", async () => {
      mockSend
        .mockResolvedValueOnce({ Attributes: { postId: "P1" } })
        .mockResolvedValueOnce({});
      await updateContentPostAnalytics("C1", "P1", {
        metrics: { views: 43, reads: 11, claps: 11 },
        capturedAt: "2026-05-27T15:30:00.000Z",
      });
      const snapshotInput = mockSend.mock.calls[1][0].input;
      expect(snapshotInput.Item.pk).toBe("CAMPAIGN#C1");
      expect(snapshotInput.Item.sk).toBe("CONTENTPOST#P1#SNAPSHOT#2026-05-27");
      expect(snapshotInput.Item.entity).toBe("ContentPostSnapshot");
      expect(snapshotInput.Item.snapshotDate).toBe("2026-05-27");
      expect(snapshotInput.Item.metrics).toEqual({ views: 43, reads: 11, claps: 11 });
      expect(snapshotInput.Item.capturedAt).toBe("2026-05-27T15:30:00.000Z");
    });

    test("404 on ConditionalCheckFailed", async () => {
      const err = new Error();
      err.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValueOnce(err);
      await expect(
        updateContentPostAnalytics("C1", "P1", { metrics: { views: 1 } }),
      ).rejects.toThrow(/ContentPost P1 not found/);
    });
  });

  describe("listContentPostSnapshots", () => {
    test("queries the SNAPSHOT prefix for the post and sorts ascending", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          { snapshotDate: "2026-05-28", metrics: { views: 50 } },
          { snapshotDate: "2026-05-27", metrics: { views: 43 } },
        ],
      });
      const out = await listContentPostSnapshots("C1", "P1");
      expect(out.map((s) => s.snapshotDate)).toEqual(["2026-05-27", "2026-05-28"]);
      const input = mockSend.mock.calls[0][0].input;
      expect(input.ExpressionAttributeValues[":pk"]).toBe("CAMPAIGN#C1");
      expect(input.ExpressionAttributeValues[":prefix"]).toBe("CONTENTPOST#P1#SNAPSHOT#");
    });
  });

  describe("listMonitoringContentPosts", () => {
    test("fans out one query per monitoring campaign and flattens with campaign join", async () => {
      campaignDomain.listCampaignsByStatus.mockResolvedValueOnce([
        { campaignId: "C1", name: "One" },
        { campaignId: "C2", name: "Two" },
      ]);
      mockSend
        .mockResolvedValueOnce({ Items: [{ postId: "P1", campaignId: "C1" }] })
        .mockResolvedValueOnce({ Items: [{ postId: "P2", campaignId: "C2" }] });

      const rows = await listMonitoringContentPosts("t1");
      expect(campaignDomain.listCampaignsByStatus).toHaveBeenCalledWith("monitoring", "t1");
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.post.postId).sort()).toEqual(["P1", "P2"]);
      expect(rows.every((r) => r.campaign.name)).toBe(true);
    });
  });

  describe("deleteContentPost", () => {
    test("404 when missing", async () => {
      const err = new Error();
      err.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValueOnce(err);
      await expect(deleteContentPost("C1", "P1")).rejects.toThrow(/ContentPost P1 not found/);
    });

    test("deletes when present", async () => {
      mockSend.mockResolvedValueOnce({});
      await deleteContentPost("C1", "P1");
      expect(mockSend.mock.calls[0][0].input.Key).toEqual({
        pk: "CAMPAIGN#C1",
        sk: "CONTENTPOST#P1",
      });
    });
  });
});
