import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";
process.env.NEWSLETTER_MINT_API_KEY = "test-mint-key";
process.env.BRIEFS_BUCKET = "test-briefs-bucket";
process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { saveBriefForCampaign, getBriefForCampaign } = await import("../domain/brief.mjs");

const CAMPAIGN_ID = "01HV0AABBCCDDEEFFGGHHJJKKM";

describe("domain/brief", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  describe("saveBriefForCampaign", () => {
    test("writes the brief under the campaign partition", async () => {
      mockSend.mockResolvedValueOnce({ Item: { pk: `CAMPAIGN#${CAMPAIGN_ID}`, sk: "METADATA" } }); // findCampaign
      mockSend.mockResolvedValueOnce({}); // Put

      const item = await saveBriefForCampaign({
        campaignId: CAMPAIGN_ID,
        sourceType: "chat",
        s3Key: `uploads/${CAMPAIGN_ID}.txt`,
        summary: "Test summary",
        suggestedCampaign: { name: "Test" },
        warnings: ["ambiguous deliverable"],
      });

      expect(item.pk).toBe(`CAMPAIGN#${CAMPAIGN_ID}`);
      expect(item.sk).toBe("BRIEF");
      expect(item.entity).toBe("Brief");
      expect(item.warnings).toEqual(["ambiguous deliverable"]);

      const putInput = mockSend.mock.calls[1][0].input;
      expect(putInput.Item.sk).toBe("BRIEF");
      // No attribute_not_exists guard — re-upload replaces the prior brief.
      expect(putInput.ConditionExpression).toBeUndefined();
    });

    test("404 when the campaign does not exist", async () => {
      mockSend.mockResolvedValueOnce({}); // findCampaign: no Item
      await expect(
        saveBriefForCampaign({
          campaignId: CAMPAIGN_ID,
          sourceType: "chat",
          s3Key: "x",
          summary: "s",
          suggestedCampaign: { name: "T" },
          warnings: [],
        }),
      ).rejects.toThrow(/Campaign .* not found/);
      // Only the findCampaign read, no Put.
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe("getBriefForCampaign", () => {
    test("returns the brief item", async () => {
      mockSend.mockResolvedValueOnce({ Item: { sk: "BRIEF", summary: "x" } });
      const brief = await getBriefForCampaign(CAMPAIGN_ID);
      expect(brief.summary).toBe("x");
      const input = mockSend.mock.calls[0][0].input;
      expect(input.Key).toEqual({ pk: `CAMPAIGN#${CAMPAIGN_ID}`, sk: "BRIEF" });
    });

    test("returns null when no brief attached", async () => {
      mockSend.mockResolvedValueOnce({});
      expect(await getBriefForCampaign(CAMPAIGN_ID)).toBeNull();
    });
  });
});
