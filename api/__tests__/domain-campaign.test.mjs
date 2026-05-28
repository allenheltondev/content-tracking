import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";
process.env.NEWSLETTER_MINT_API_KEY = "test-mint-key";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const {
  createCampaign,
  getCampaignWithLinks,
  listCampaigns,
  queryCampaignsByDateRange,
  updateCampaignFields,
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
      const { metadata, links, brief } = await getCampaignWithLinks("C1");
      expect(metadata.name).toBe("x");
      expect(links.length).toBe(2);
      expect(brief).toBeNull();
    });

    test("surfaces the attached brief item", async () => {
      mockSend.mockResolvedValue({
        Items: [
          { pk: "CAMPAIGN#C1", sk: "METADATA", campaignId: "C1", name: "x", status: "active", createdAt: "2026-01-01" },
          { pk: "CAMPAIGN#C1", sk: "BRIEF", summary: "the brief", sourceType: "pdf" },
        ],
      });
      const { brief, links } = await getCampaignWithLinks("C1");
      expect(links.length).toBe(0);
      expect(brief.summary).toBe("the brief");
    });

    test("404 when no metadata row", async () => {
      mockSend.mockResolvedValue({ Items: [] });
      await expect(getCampaignWithLinks("C1")).rejects.toThrow(/Campaign C1 not found/);
    });

    test("excludes SocialPostSnapshot rows from socialPosts", async () => {
      mockSend.mockResolvedValue({
        Items: [
          { pk: "CAMPAIGN#C1", sk: "METADATA", campaignId: "C1", name: "x", status: "monitoring", createdAt: "2026-01-01" },
          { pk: "CAMPAIGN#C1", sk: "SOCIALPOST#P1", entity: "SocialPost", postId: "P1", createdAt: "2026-05-01T00:00:00.000Z" },
          { pk: "CAMPAIGN#C1", sk: "SOCIALPOST#P1#SNAPSHOT#2026-05-27", entity: "SocialPostSnapshot", postId: "P1", snapshotDate: "2026-05-27" },
          { pk: "CAMPAIGN#C1", sk: "SOCIALPOST#P1#SNAPSHOT#2026-05-28", entity: "SocialPostSnapshot", postId: "P1", snapshotDate: "2026-05-28" },
        ],
      });
      const { socialPosts } = await getCampaignWithLinks("C1");
      expect(socialPosts.length).toBe(1);
      expect(socialPosts[0].postId).toBe("P1");
      expect(socialPosts[0].entity).toBe("SocialPost");
    });
  });

  describe("updateCampaignFields", () => {
    test("single conditional Update when campaign has no vendor", async () => {
      mockSend.mockResolvedValueOnce({ Item: { campaignId: "C1", name: "Old" } }); // findCampaign
      mockSend.mockResolvedValueOnce({ Attributes: { campaignId: "C1", name: "New", status: "active" } }); // Update

      const updated = await updateCampaignFields("C1", { name: "New", status: "active" });
      expect(updated.name).toBe("New");

      const input = mockSend.mock.calls[1][0].input;
      expect(input.UpdateExpression).toBe("SET #name = :name, #status = :status");
      expect(input.ExpressionAttributeValues[":name"]).toBe("New");
      expect(input.ConditionExpression).toBe("attribute_exists(pk)");
      expect(input.ReturnValues).toBe("ALL_NEW");
    });

    test("transaction updates the vendor companion row for mirrored fields", async () => {
      mockSend.mockResolvedValueOnce({ Item: { campaignId: "C1", vendorId: VALID_VENDOR_ID } }); // findCampaign
      mockSend.mockResolvedValueOnce({}); // transaction

      await updateCampaignFields("C1", { name: "New", startDate: "2026-06-01", payout: { amount: 5, currency: "USD", paid: false } });

      const transactCall = mockSend.mock.calls.find((c) => c[0].input?.TransactItems);
      const items = transactCall[0].input.TransactItems;
      expect(items.length).toBe(2);

      // Metadata row gets every field; companion row gets only mirrored ones.
      expect(items[0].Update.Key).toEqual({ pk: "CAMPAIGN#C1", sk: "METADATA" });
      expect(items[1].Update.Key).toEqual({ pk: `VENDOR#${VALID_VENDOR_ID}`, sk: "CAMPAIGN#C1" });
      expect(items[1].Update.UpdateExpression).toBe("SET #name = :name, #startDate = :startDate");
    });

    test("no companion-row Update when only non-mirrored fields change", async () => {
      mockSend.mockResolvedValueOnce({ Item: { campaignId: "C1", vendorId: VALID_VENDOR_ID } }); // findCampaign
      mockSend.mockResolvedValueOnce({}); // transaction

      await updateCampaignFields("C1", { payout: { amount: 5, currency: "USD", paid: false } });

      const transactCall = mockSend.mock.calls.find((c) => c[0].input?.TransactItems);
      expect(transactCall[0].input.TransactItems.length).toBe(1);
    });

    test("404 when campaign is missing", async () => {
      mockSend.mockResolvedValueOnce({}); // findCampaign: no Item
      await expect(updateCampaignFields("C1", { name: "New" })).rejects.toThrow(/Campaign C1 not found/);
    });

    test("no-op returns existing campaign without writing", async () => {
      mockSend.mockResolvedValueOnce({ Item: { campaignId: "C1", name: "Old" } }); // findCampaign
      const updated = await updateCampaignFields("C1", {});
      expect(updated.name).toBe("Old");
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test("links a vendor when the campaign had none: writes companion row + snapshots name", async () => {
      mockSend.mockResolvedValueOnce({ Item: { campaignId: "C1", name: "Launch", status: "active", createdAt: "2026-01-01" } }); // findCampaign
      mockSend.mockResolvedValueOnce({ Item: { vendorId: VALID_VENDOR_ID, name: "Acme" } }); // findVendor
      mockSend.mockResolvedValueOnce({}); // transaction

      const updated = await updateCampaignFields("C1", { vendorId: VALID_VENDOR_ID });
      expect(updated.vendorId).toBe(VALID_VENDOR_ID);
      expect(updated.sponsor).toBe("Acme"); // snapshotted from the vendor

      const transactCall = mockSend.mock.calls.find((c) => c[0].input?.TransactItems);
      const items = transactCall[0].input.TransactItems;
      // No old vendor → just metadata Update + new companion Put.
      expect(items.length).toBe(2);
      expect(items[0].Update.Key).toEqual({ pk: "CAMPAIGN#C1", sk: "METADATA" });
      const put = items[1].Put.Item;
      expect(put.pk).toBe(`VENDOR#${VALID_VENDOR_ID}`);
      expect(put.sk).toBe("CAMPAIGN#C1");
      expect(put.entity).toBe("CampaignByVendor");
      expect(put.createdAt).toBe("2026-01-01");
    });

    test("re-links to a different vendor: deletes the old companion row, writes the new one", async () => {
      mockSend.mockResolvedValueOnce({ Item: { campaignId: "C1", name: "Launch", status: "active", vendorId: "old_vendor", createdAt: "2026-01-01" } }); // findCampaign
      mockSend.mockResolvedValueOnce({ Item: { vendorId: VALID_VENDOR_ID, name: "Acme" } }); // findVendor
      mockSend.mockResolvedValueOnce({}); // transaction

      await updateCampaignFields("C1", { vendorId: VALID_VENDOR_ID });

      const transactCall = mockSend.mock.calls.find((c) => c[0].input?.TransactItems);
      const items = transactCall[0].input.TransactItems;
      // metadata Update + Delete(old companion) + Put(new companion)
      expect(items.length).toBe(3);
      expect(items[1].Delete.Key).toEqual({ pk: "VENDOR#old_vendor", sk: "CAMPAIGN#C1" });
      expect(items[2].Put.Item.pk).toBe(`VENDOR#${VALID_VENDOR_ID}`);
    });

    test("keeps a caller-supplied sponsor when re-linking instead of snapshotting", async () => {
      mockSend.mockResolvedValueOnce({ Item: { campaignId: "C1", name: "Launch", status: "active", createdAt: "2026-01-01" } }); // findCampaign
      mockSend.mockResolvedValueOnce({ Item: { vendorId: VALID_VENDOR_ID, name: "Acme" } }); // findVendor
      mockSend.mockResolvedValueOnce({}); // transaction

      const updated = await updateCampaignFields("C1", { vendorId: VALID_VENDOR_ID, sponsor: "Custom" });
      expect(updated.sponsor).toBe("Custom");
    });

    test("404 when the new vendor_id refers to a missing vendor", async () => {
      mockSend.mockResolvedValueOnce({ Item: { campaignId: "C1", name: "Launch" } }); // findCampaign
      mockSend.mockResolvedValueOnce({}); // findVendor: no Item
      await expect(
        updateCampaignFields("C1", { vendorId: VALID_VENDOR_ID }),
      ).rejects.toThrow(/Vendor .* not found/);
    });

    test("vendor_id equal to the current one takes the normal (non-reassign) path", async () => {
      mockSend.mockResolvedValueOnce({ Item: { campaignId: "C1", name: "Launch", vendorId: VALID_VENDOR_ID } }); // findCampaign
      mockSend.mockResolvedValueOnce({}); // transaction (mirror path, since campaign has a vendor)

      await updateCampaignFields("C1", { vendorId: VALID_VENDOR_ID, name: "New" });

      // findVendor is never called: only findCampaign + the write.
      expect(mockSend).toHaveBeenCalledTimes(2);
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
