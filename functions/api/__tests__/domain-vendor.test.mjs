import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-content-tracking";
process.env.ENVIRONMENT = "staging";
process.env.NEWSLETTER_MINT_API_KEY = "test-mint-key";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const {
  createVendor,
  getVendor,
  listVendors,
  updateVendor,
  deleteVendor,
  listCampaignsForVendor,
  findVendor,
} = await import("../domain/vendor.mjs");

describe("domain/vendor", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  describe("createVendor", () => {
    test("writes a Vendor item with GSI1 keys", async () => {
      mockSend.mockResolvedValue({});
      const item = await createVendor({ name: "Acme" });

      expect(item.vendorId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(item.pk).toBe(`VENDOR#${item.vendorId}`);
      expect(item.sk).toBe("METADATA");
      expect(item.gsi1pk).toBe("VENDORS");
      expect(item.gsi1sk).toBe(`${item.createdAt}#${item.vendorId}`);
      expect(item.entity).toBe("Vendor");

      const call = mockSend.mock.calls[0][0];
      expect(call.input.ConditionExpression).toMatch(/attribute_not_exists/);
    });
  });

  describe("getVendor", () => {
    test("returns the item", async () => {
      mockSend.mockResolvedValue({ Item: { vendorId: "V1", name: "Acme" } });
      const item = await getVendor("V1");
      expect(item.name).toBe("Acme");
    });

    test("throws NotFoundError when missing", async () => {
      mockSend.mockResolvedValue({});
      await expect(getVendor("V1")).rejects.toThrow(/Vendor V1 not found/);
    });
  });

  describe("findVendor", () => {
    test("returns null when missing (does not throw)", async () => {
      mockSend.mockResolvedValue({});
      expect(await findVendor("V1")).toBeNull();
    });
  });

  describe("listVendors", () => {
    test("Queries GSI1 with VENDORS partition, newest first", async () => {
      mockSend.mockResolvedValue({
        Items: [
          { vendorId: "V1", name: "Acme", createdAt: "2026-05-01" },
          { vendorId: "V2", name: "Beta", createdAt: "2026-05-02" },
        ],
      });
      const { items, lastEvaluatedKey } = await listVendors({ limit: 100 });

      const input = mockSend.mock.calls[0][0].input;
      expect(input.IndexName).toBe("GSI1");
      expect(input.KeyConditionExpression).toBe("gsi1pk = :pk");
      expect(input.ExpressionAttributeValues).toEqual({ ":pk": "VENDORS" });
      expect(input.ScanIndexForward).toBe(false);
      expect(items.length).toBe(2);
      expect(lastEvaluatedKey).toBeUndefined();
    });
  });

  describe("updateVendor", () => {
    test("nulls move to REMOVE clauses", async () => {
      mockSend.mockResolvedValue({
        Attributes: { vendorId: "V1", name: "Acme" },
      });
      await updateVendor("V1", { contact_email: null, name: "Acme" });
      const input = mockSend.mock.calls[0][0].input;
      expect(input.UpdateExpression).toMatch(/SET #name = :name, #updatedAt = :updatedAt REMOVE #contact_email/);
    });

    test("ConditionalCheckFailed becomes NotFoundError", async () => {
      const err = new Error();
      err.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValue(err);
      await expect(updateVendor("V1", { name: "x" })).rejects.toThrow(/Vendor V1 not found/);
    });
  });

  describe("deleteVendor", () => {
    test("ConflictError when linked campaigns exist", async () => {
      mockSend.mockResolvedValueOnce({ Count: 2 });
      await expect(deleteVendor("V1")).rejects.toThrow(/2 linked campaign/);
    });

    test("deletes when no linked campaigns", async () => {
      mockSend.mockResolvedValueOnce({ Count: 0 }); // linked check
      mockSend.mockResolvedValueOnce({});           // delete
      await expect(deleteVendor("V1")).resolves.toBeUndefined();
    });

    test("404 when vendor doesn't exist", async () => {
      mockSend.mockResolvedValueOnce({ Count: 0 });
      const err = new Error();
      err.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValueOnce(err);
      await expect(deleteVendor("V1")).rejects.toThrow(/Vendor V1 not found/);
    });
  });

  describe("listCampaignsForVendor", () => {
    test("404 when vendor missing", async () => {
      mockSend.mockResolvedValueOnce({}); // GetItem
      await expect(listCampaignsForVendor("V1")).rejects.toThrow(/Vendor V1 not found/);
    });

    test("returns linked campaigns when vendor exists", async () => {
      mockSend.mockResolvedValueOnce({ Item: { pk: "VENDOR#V1" } });
      mockSend.mockResolvedValueOnce({
        Items: [{ campaignId: "C1", name: "Campaign1", status: "active", createdAt: "2026-01-01" }],
      });
      const items = await listCampaignsForVendor("V1");
      expect(items.length).toBe(1);
      expect(items[0].name).toBe("Campaign1");
    });
  });
});
