import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-content-tracking";
process.env.ENVIRONMENT = "staging";
process.env.NEWSLETTER_MINT_API_KEY = "test-mint-key";
process.env.BRIEFS_BUCKET = "test-briefs-bucket";
process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const {
  createBriefRecord,
  getBriefWithCampaign,
  persistBriefSummary,
  newBriefId,
} = await import("../domain/brief.mjs");

describe("domain/brief", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  describe("createBriefRecord", () => {
    test("single-put transaction without campaignDraft", async () => {
      mockSend.mockResolvedValueOnce({});
      const briefId = newBriefId();
      const item = await createBriefRecord({
        briefId,
        sourceType: "chat",
        s3Key: `uploads/${briefId}.txt`,
        summary: "Test summary",
        suggestedCampaign: { name: "Test" },
        warnings: [],
      });

      expect(item.pk).toBe(`BRIEF#${briefId}`);
      expect(item.gsi1pk).toBe("BRIEFS");
      expect(item.gsi1sk).toBe(`${item.createdAt}#${briefId}`);

      const input = mockSend.mock.calls[0][0].input;
      expect(input.TransactItems.length).toBe(1);
    });

    test("three-put transaction with campaignDraft", async () => {
      mockSend.mockResolvedValueOnce({});
      const briefId = newBriefId();
      const campaignDraft = {
        pk: "CAMPAIGN#C1",
        sk: "METADATA",
        entity: "Campaign",
        campaignId: "C1",
        name: "From brief",
        status: "draft",
        createdAt: "2026-05-01T00:00:00.000Z",
      };
      await createBriefRecord({
        briefId,
        sourceType: "pdf",
        s3Key: `uploads/${briefId}.pdf`,
        summary: "Summary",
        suggestedCampaign: { name: "From brief" },
        warnings: [],
        campaignDraft,
      });

      const input = mockSend.mock.calls[0][0].input;
      expect(input.TransactItems.length).toBe(3);

      const linkItem = input.TransactItems[2].Put.Item;
      expect(linkItem.pk).toBe(`BRIEF#${briefId}`);
      expect(linkItem.sk).toBe("CAMPAIGN#C1");
      expect(linkItem.entity).toBe("CampaignByBrief");
    });
  });

  describe("getBriefWithCampaign", () => {
    test("returns metadata + linked campaign id", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          { sk: "METADATA", briefId: "B1", summary: "x", sourceType: "chat", createdAt: "2026-05-01" },
          { sk: "CAMPAIGN#C1", campaignId: "C1" },
        ],
      });
      const { metadata, campaignId } = await getBriefWithCampaign("B1");
      expect(metadata.summary).toBe("x");
      expect(campaignId).toBe("C1");
    });

    test("404 when no metadata row", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });
      await expect(getBriefWithCampaign("B1")).rejects.toThrow(/Brief B1 not found/);
    });

    test("returns null campaign id when no link", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [{ sk: "METADATA", briefId: "B1", summary: "x", sourceType: "chat", createdAt: "2026-05-01" }],
      });
      const { campaignId } = await getBriefWithCampaign("B1");
      expect(campaignId).toBeNull();
    });
  });

  describe("persistBriefSummary", () => {
    test("writes a single-put record", async () => {
      mockSend.mockResolvedValueOnce({});
      await persistBriefSummary({
        briefId: "B1",
        sourceType: "chat",
        s3Key: "uploads/B1.txt",
        summary: "Summary",
        suggestedCampaign: { name: "Test" },
        warnings: ["ambiguous deliverable"],
      });
      const input = mockSend.mock.calls[0][0].input;
      expect(input.TransactItems.length).toBe(1);
      expect(input.TransactItems[0].Put.Item.warnings).toEqual(["ambiguous deliverable"]);
    });
  });
});
