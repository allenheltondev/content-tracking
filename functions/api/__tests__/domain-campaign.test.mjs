import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-content-tracking";
process.env.ENVIRONMENT = "staging";
process.env.NEWSLETTER_MINT_API_KEY = "test-mint-key";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const {
  createCampaign,
  getCampaignWithLinks,
  listCampaigns,
  queryCampaignsByDateRange,
  updateCampaignPayout,
} = await import("../domain/campaign.mjs");

const VALID_VENDOR_ID = "01HV0AABBCCDDEEFFGGHHJJKKM";

describe("domain/campaign", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  describe("createCampaign", () => {
    test("writes single-item transaction without vendor", async () => {
      mockSend.mockResolvedValue({});
      const item = await createCampaign({ name: "Launch", status: "active" });

      expect(item.entity).toBe("Campaign");
      expect(item.gsi1pk).toBe("CAMPAIGNS");
      expect(item.gsi1sk).toBe(`${item.createdAt}#${item.campaignId}`);

      // Only the TransactWriteItems call (no vendor pre-check)
      const transactCall = mockSend.mock.calls.find((c) => c[0].input.TransactItems);
      expect(transactCall).toBeDefined();
      expect(transactCall[0].input.TransactItems.length).toBe(1);
    });

    test("404 when vendor_id refers to a missing vendor", async () => {
      // First call: findVendor returns missing
      mockSend.mockResolvedValueOnce({});
      await expect(
        createCampaign({ name: "Launch", status: "active", vendorId: VALID_VENDOR_ID }),
      ).rejects.toThrow(/Vendor .* not found/);
    });

    test("writes campaign + vendor index entry transactionally when vendor exists", async () => {
      mockSend.mockResolvedValueOnce({ Item: { pk: `VENDOR#${VALID_VENDOR_ID}` } }); // findVendor
      mockSend.mockResolvedValueOnce({}); // transaction

      const item = await createCampaign({
        name: "Linked",
        status: "active",
        vendorId: VALID_VENDOR_ID,
        startDate: "2026-05-01",
      });

      expect(item.vendorId).toBe(VALID_VENDOR_ID);

      const transactCall = mockSend.mock.calls.find((c) => c[0].input.TransactItems);
      expect(transactCall[0].input.TransactItems.length).toBe(2);

      const indexEntry = transactCall[0].input.TransactItems[1].Put.Item;
      expect(indexEntry.pk).toBe(`VENDOR#${VALID_VENDOR_ID}`);
      expect(indexEntry.sk).toBe(`CAMPAIGN#${item.campaignId}`);
      expect(indexEntry.entity).toBe("CampaignByVendor");
    });
  });

  describe("getCampaignWithLinks", () => {
    test("returns metadata + filtered link items", async () => {
      mockSend.mockResolvedValue({
        Items: [
          { pk: "CAMPAIGN#C1", sk: "METADATA", campaignId: "C1", name: "x", status: "active", createdAt: "2026-01-01" },
          { pk: "CAMPAIGN#C1", sk: "LINK#L1", linkId: "L1" },
          { pk: "CAMPAIGN#C1", sk: "LINK#L2", linkId: "L2" },
        ],
      });
      const { metadata, links } = await getCampaignWithLinks("C1");
      expect(metadata.name).toBe("x");
      expect(links.length).toBe(2);
    });

    test("404 when no metadata row", async () => {
      mockSend.mockResolvedValue({ Items: [] });
      await expect(getCampaignWithLinks("C1")).rejects.toThrow(/Campaign C1 not found/);
    });
  });

  describe("listCampaigns", () => {
    test("Queries GSI1 with CAMPAIGNS partition", async () => {
      mockSend.mockResolvedValue({ Items: [] });
      await listCampaigns({ limit: 50 });

      const input = mockSend.mock.calls[0][0].input;
      expect(input.IndexName).toBe("GSI1");
      expect(input.KeyConditionExpression).toBe("gsi1pk = :pk");
      expect(input.ExpressionAttributeValues).toEqual({ ":pk": "CAMPAIGNS" });
      expect(input.ScanIndexForward).toBe(false);
    });

    test("adds status filter when provided", async () => {
      mockSend.mockResolvedValue({ Items: [] });
      await listCampaigns({ limit: 50, status: "active" });
      const input = mockSend.mock.calls[0][0].input;
      expect(input.FilterExpression).toBe("#status = :status");
      expect(input.ExpressionAttributeValues[":status"]).toBe("active");
    });
  });

  describe("queryCampaignsByDateRange", () => {
    test("Queries GSI1 with BETWEEN on gsi1sk", async () => {
      mockSend.mockResolvedValue({ Items: [{ campaignId: "C1", createdAt: "2026-05-01T00:00:00.000Z" }] });
      const items = await queryCampaignsByDateRange({
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      expect(items.length).toBe(1);
      const input = mockSend.mock.calls[0][0].input;
      expect(input.KeyConditionExpression).toMatch(/gsi1sk BETWEEN/);
      expect(input.ExpressionAttributeValues[":start"]).toMatch(/^2026-01-01/);
      expect(input.ExpressionAttributeValues[":end"]).toMatch(/^2026-12-31.*~$/);
    });
  });

  describe("updateCampaignPayout", () => {
    test("nested SET under #payout", async () => {
      mockSend.mockResolvedValue({ Attributes: { campaignId: "C1" } });
      await updateCampaignPayout("C1", { amount: 5000, currency: "USD" });
      const input = mockSend.mock.calls[0][0].input;
      expect(input.UpdateExpression).toMatch(/SET #payout = if_not_exists/);
      expect(input.UpdateExpression).toMatch(/#payout\.#amount = :amount/);
    });

    test("null paid_at moves to REMOVE", async () => {
      mockSend.mockResolvedValue({ Attributes: { campaignId: "C1" } });
      await updateCampaignPayout("C1", { paid_at: null });
      const input = mockSend.mock.calls[0][0].input;
      expect(input.UpdateExpression).toMatch(/REMOVE #payout\.#paid_at/);
    });

    test("404 on missing campaign", async () => {
      const err = new Error();
      err.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValue(err);
      await expect(updateCampaignPayout("C1", { amount: 5000 })).rejects.toThrow(/Campaign C1 not found/);
    });
  });
});
