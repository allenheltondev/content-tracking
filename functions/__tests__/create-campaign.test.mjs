import { jest } from "@jest/globals";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";

const { handler } = await import("../create-campaign.mjs");

describe("create-campaign", () => {
  let mockDdbSend;

  beforeEach(() => {
    mockDdbSend = jest.fn().mockResolvedValue({});
    DynamoDBClient.prototype.send = mockDdbSend;
    jest.clearAllMocks();
  });

  const invoke = (body) => handler({ body: typeof body === "string" ? body : JSON.stringify(body) });

  describe("validation", () => {
    test("returns 400 on missing body", async () => {
      const res = await handler({});
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/body/i);
    });

    test("returns 400 on invalid JSON", async () => {
      const res = await invoke("not json{");
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when name is missing", async () => {
      const res = await invoke({});
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/name/);
    });

    test("returns 400 when name is empty whitespace", async () => {
      const res = await invoke({ name: "   " });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when status is not in the enum", async () => {
      const res = await invoke({ name: "ok", status: "archived" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/status/);
    });

    test("returns 400 when startDate is malformed", async () => {
      const res = await invoke({ name: "ok", startDate: "2026/01/01" });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when targetMetrics is an array", async () => {
      const res = await invoke({ name: "ok", targetMetrics: [1, 2] });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when vendor_id is not a ULID", async () => {
      const res = await invoke({ name: "ok", vendor_id: "lowercase-id" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/vendor_id/);
    });
  });

  describe("happy path", () => {
    test("creates a campaign with defaults and returns 201", async () => {
      const res = await invoke({ name: "Launch 2026" });
      expect(res.statusCode).toBe(201);

      const body = JSON.parse(res.body);
      expect(body.campaign_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(body.name).toBe("Launch 2026");
      expect(body.status).toBe("active");
      expect(body.sponsor).toBeNull();
      expect(body.vendor_id).toBeNull();
      expect(body.startDate).toBeNull();

      // Single-item transaction when there's no vendor_id
      const transactInput = mockDdbSend.mock.calls[0][0].input;
      expect(transactInput.TransactItems.length).toBe(1);
      const item = unmarshall(transactInput.TransactItems[0].Put.Item);
      expect(item.pk).toBe(`CAMPAIGN#${body.campaign_id}`);
      expect(item.sk).toBe("METADATA");
      expect(item.entity).toBe("Campaign");
    });

    test("stores all provided fields with legacy sponsor string", async () => {
      const res = await invoke({
        name: "Q2 Push",
        sponsor: "AcmeCorp",
        startDate: "2026-04-01",
        endDate: "2026-06-30",
        status: "draft",
        targetMetrics: { impressions: 50000 },
      });
      expect(res.statusCode).toBe(201);

      const body = JSON.parse(res.body);
      expect(body.sponsor).toBe("AcmeCorp");
      expect(body.vendor_id).toBeNull();
      expect(body.targetMetrics).toEqual({ impressions: 50000 });
    });

    test("trims whitespace from name", async () => {
      const res = await invoke({ name: "  hello  " });
      const body = JSON.parse(res.body);
      expect(body.name).toBe("hello");
    });
  });

  describe("vendor_id linking", () => {
    const validVendorId = "01HV0AABBCCDDEEFFGGHHJJKKM";

    test("returns 404 when the referenced vendor doesn't exist", async () => {
      mockDdbSend.mockImplementation((cmd) => {
        if (cmd instanceof GetItemCommand) return Promise.resolve({});
        return Promise.resolve({});
      });

      const res = await invoke({ name: "Launch", vendor_id: validVendorId });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toMatch(/Vendor/);
    });

    test("writes both campaign metadata and vendor index entry transactionally", async () => {
      mockDdbSend.mockImplementation((cmd) => {
        if (cmd instanceof GetItemCommand) {
          return Promise.resolve({ Item: marshall({ pk: `VENDOR#${validVendorId}` }) });
        }
        return Promise.resolve({});
      });

      const res = await invoke({
        name: "Linked Campaign",
        vendor_id: validVendorId,
        startDate: "2026-05-01",
      });
      expect(res.statusCode).toBe(201);

      const body = JSON.parse(res.body);
      expect(body.vendor_id).toBe(validVendorId);

      const transactCall = mockDdbSend.mock.calls.find((c) => c[0] instanceof TransactWriteItemsCommand);
      expect(transactCall).toBeDefined();
      expect(transactCall[0].input.TransactItems.length).toBe(2);

      const metadata = unmarshall(transactCall[0].input.TransactItems[0].Put.Item);
      const indexEntry = unmarshall(transactCall[0].input.TransactItems[1].Put.Item);

      expect(metadata.pk).toBe(`CAMPAIGN#${body.campaign_id}`);
      expect(metadata.vendorId).toBe(validVendorId);

      expect(indexEntry.pk).toBe(`VENDOR#${validVendorId}`);
      expect(indexEntry.sk).toBe(`CAMPAIGN#${body.campaign_id}`);
      expect(indexEntry.entity).toBe("CampaignByVendor");
      expect(indexEntry.name).toBe("Linked Campaign");
      expect(indexEntry.startDate).toBe("2026-05-01");
    });
  });
});
