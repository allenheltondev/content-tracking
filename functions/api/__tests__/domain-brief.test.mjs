import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-content-tracking";
process.env.ENVIRONMENT = "staging";
process.env.NEWSLETTER_MINT_API_KEY = "test-mint-key";
process.env.BRIEFS_BUCKET = "test-briefs-bucket";
process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const {
  confirmBriefAsCampaign,
  createBriefRecord,
  getBriefWithCampaign,
  persistBriefSummary,
  newBriefId,
} = await import("../domain/brief.mjs");

const VALID_VENDOR_ID = "01HV0AABBCCDDEEFFGGHHJJKKM";

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

  describe("confirmBriefAsCampaign", () => {
    test("returns existing campaign id when already confirmed", async () => {
      // First call: getBriefWithCampaign Query returns metadata + link
      mockSend.mockResolvedValueOnce({
        Items: [
          { sk: "METADATA", briefId: "B1", summary: "x", sourceType: "chat" },
          { sk: "CAMPAIGN#EXISTING", campaignId: "EXISTING" },
        ],
      });
      const result = await confirmBriefAsCampaign({
        briefId: "B1",
        campaignFields: { name: "Edited" },
        acceptedSuggestion: { name: "Edited" },
      });
      expect(result.alreadyConfirmed).toBe(true);
      expect(result.campaignId).toBe("EXISTING");
      // Only the Query, no transaction
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test("404 when brief is missing", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });
      await expect(
        confirmBriefAsCampaign({
          briefId: "B1",
          campaignFields: { name: "Edited" },
          acceptedSuggestion: { name: "Edited" },
        }),
      ).rejects.toThrow(/Brief B1 not found/);
    });

    test("404 when vendorId points to missing vendor", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [{ sk: "METADATA", briefId: "B1", summary: "x", sourceType: "chat" }],
      });
      mockSend.mockResolvedValueOnce({}); // findVendor: no Item
      await expect(
        confirmBriefAsCampaign({
          briefId: "B1",
          campaignFields: { name: "Edited", vendorId: VALID_VENDOR_ID },
          acceptedSuggestion: { name: "Edited" },
        }),
      ).rejects.toThrow(/Vendor .* not found/);
    });

    test("writes 3-item transaction without vendor", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [{ sk: "METADATA", briefId: "B1", summary: "x", sourceType: "chat" }],
      });
      mockSend.mockResolvedValueOnce({}); // transaction
      const result = await confirmBriefAsCampaign({
        briefId: "B1",
        campaignFields: { name: "Edited", status: "draft" },
        acceptedSuggestion: { name: "Edited", deliverables: [{ platform: "ig", type: "reel" }] },
      });
      expect(result.alreadyConfirmed).toBe(false);
      expect(result.campaignId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

      const transactCall = mockSend.mock.calls.find((c) => c[0].input?.TransactItems);
      expect(transactCall).toBeDefined();
      const items = transactCall[0].input.TransactItems;
      expect(items.length).toBe(3);

      const campaignPut = items[0].Put.Item;
      expect(campaignPut.entity).toBe("Campaign");
      expect(campaignPut.name).toBe("Edited");
      expect(campaignPut.briefId).toBe("B1");
      expect(campaignPut.gsi1pk).toBe("CAMPAIGNS");

      const briefLink = items[1].Put.Item;
      expect(briefLink.pk).toBe("BRIEF#B1");
      expect(briefLink.sk).toBe(`CAMPAIGN#${result.campaignId}`);

      const briefUpdate = items[2].Update;
      expect(briefUpdate.Key).toEqual({ pk: "BRIEF#B1", sk: "METADATA" });
      expect(briefUpdate.ExpressionAttributeValues[":sc"].deliverables).toEqual([
        { platform: "ig", type: "reel" },
      ]);
    });

    test("includes vendor index entry when vendorId given", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [{ sk: "METADATA", briefId: "B1", summary: "x", sourceType: "chat" }],
      });
      mockSend.mockResolvedValueOnce({ Item: { pk: `VENDOR#${VALID_VENDOR_ID}` } }); // findVendor
      mockSend.mockResolvedValueOnce({}); // transaction
      await confirmBriefAsCampaign({
        briefId: "B1",
        campaignFields: { name: "Edited", status: "draft", vendorId: VALID_VENDOR_ID },
        acceptedSuggestion: { name: "Edited" },
      });
      const transactCall = mockSend.mock.calls.find((c) => c[0].input?.TransactItems);
      const items = transactCall[0].input.TransactItems;
      expect(items.length).toBe(4);
      expect(items[3].Put.Item.pk).toBe(`VENDOR#${VALID_VENDOR_ID}`);
      expect(items[3].Put.Item.entity).toBe("CampaignByVendor");
    });

    test("carries payout into the campaign metadata", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [{ sk: "METADATA", briefId: "B1", summary: "x", sourceType: "chat" }],
      });
      mockSend.mockResolvedValueOnce({});
      await confirmBriefAsCampaign({
        briefId: "B1",
        campaignFields: { name: "Edited", status: "draft" },
        acceptedSuggestion: { name: "Edited" },
        payout: { amount: 2000, currency: "USD", paid: false },
      });
      const transactCall = mockSend.mock.calls.find((c) => c[0].input?.TransactItems);
      const campaignPut = transactCall[0].input.TransactItems[0].Put.Item;
      expect(campaignPut.payout).toEqual({ amount: 2000, currency: "USD", paid: false });
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
