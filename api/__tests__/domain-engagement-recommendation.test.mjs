import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { ConditionalCheckFailedException } = await import("@aws-sdk/client-dynamodb");
const {
  saveEngagementRecommendation,
  getEngagementRecommendation,
} = await import("../domain/engagement-recommendation.mjs");

describe("domain/engagement-recommendation", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  describe("saveEngagementRecommendation", () => {
    test("writes the recommendation under the content-post partition with its own entity", async () => {
      mockSend.mockResolvedValueOnce({});

      const item = await saveEngagementRecommendation("C1", "P1", {
        summary: "Spread it around.",
        recommendations: [{ channel: "reddit r/webdev", action: "promote", priority: "high", rationale: "fit", suggested_message: "hi" }],
        already_covered: ["x"],
      });

      expect(item.pk).toBe("CAMPAIGN#C1");
      expect(item.sk).toBe("CONTENTPOST#P1#RECOMMENDATIONS");
      expect(item.entity).toBe("ContentPostRecommendation");
      expect(item.summary).toBe("Spread it around.");
      expect(item.recommendations).toHaveLength(1);
      expect(item.alreadyCovered).toEqual(["x"]);
      expect(item.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const putArg = mockSend.mock.calls[0][0].input;
      expect(putArg.TableName).toBe("test-booked");
      expect(putArg.ConditionExpression).toContain("entity = :entity");
    });

    test("defaults missing recommendation arrays to empty", async () => {
      mockSend.mockResolvedValueOnce({});
      const item = await saveEngagementRecommendation("C1", "P1", { summary: "x" });
      expect(item.recommendations).toEqual([]);
      expect(item.alreadyCovered).toEqual([]);
    });

    test("maps a conditional-check failure to NotFound", async () => {
      mockSend.mockRejectedValueOnce(
        new ConditionalCheckFailedException({ message: "nope", $metadata: {} }),
      );
      await expect(
        saveEngagementRecommendation("C1", "P1", { summary: "x" }),
      ).rejects.toThrow(/ContentPostRecommendation P1 not found/);
    });
  });

  describe("getEngagementRecommendation", () => {
    test("returns the stored item", async () => {
      mockSend.mockResolvedValueOnce({ Item: { summary: "stored", postId: "P1" } });
      const got = await getEngagementRecommendation("C1", "P1");
      expect(got.summary).toBe("stored");
      const getArg = mockSend.mock.calls[0][0].input;
      expect(getArg.Key).toEqual({ pk: "CAMPAIGN#C1", sk: "CONTENTPOST#P1#RECOMMENDATIONS" });
    });

    test("returns null when nothing has been generated yet", async () => {
      mockSend.mockResolvedValueOnce({});
      expect(await getEngagementRecommendation("C1", "P1")).toBeNull();
    });
  });
});
