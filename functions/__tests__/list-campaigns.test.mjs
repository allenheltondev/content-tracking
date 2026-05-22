import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";

const { handler } = await import("../list-campaigns.mjs");

// Valid ULIDs use the Crockford base32 alphabet: 0-9 plus A-Z minus I,L,O,U.
const VENDOR_ULID_A = "01HV0EXAMPVEND00000000000A";
const VENDOR_ULID_B = "01HV0EXAMPVEND00000000000B";

const campaignRow = (id, name, createdAt, extras = {}) => marshall({
  pk: `CAMPAIGN#${id}`,
  sk: "METADATA",
  entity: "Campaign",
  campaignId: id,
  name,
  status: "active",
  createdAt,
  ...extras,
}, { removeUndefinedValues: true });

describe("list-campaigns", () => {
  let mockDdbSend;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;
    jest.clearAllMocks();
  });

  test("returns empty list when no campaigns exist", async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    const res = await handler({});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ campaigns: [], nextStartKey: null });
  });

  test("returns campaigns sorted by created_at descending", async () => {
    mockDdbSend.mockResolvedValue({
      Items: [
        campaignRow("c-old", "Old campaign", "2026-01-01T00:00:00.000Z"),
        campaignRow("c-new", "New campaign", "2026-05-01T00:00:00.000Z"),
        campaignRow("c-mid", "Mid campaign", "2026-03-15T00:00:00.000Z"),
      ],
    });
    const res = await handler({});
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.campaigns.map((c) => c.campaign_id)).toEqual(["c-new", "c-mid", "c-old"]);
    expect(body.nextStartKey).toBeNull();
  });

  test("formats campaign with payout, vendor_id, and nullable fields", async () => {
    mockDdbSend.mockResolvedValue({
      Items: [
        campaignRow("c-1", "Campaign 1", "2026-04-01T00:00:00.000Z", {
          sponsor: "AcmeCorp",
          vendorId: VENDOR_ULID_A,
          startDate: "2026-04-01",
          endDate: "2026-06-30",
          targetMetrics: { impressions: 10000 },
          payout: { amount: 500, currency: "USD", paid: true, paid_at: "2026-05-15" },
        }),
      ],
    });
    const res = await handler({});
    const body = JSON.parse(res.body);
    expect(body.campaigns[0]).toEqual({
      campaign_id: "c-1",
      name: "Campaign 1",
      sponsor: "AcmeCorp",
      vendor_id: VENDOR_ULID_A,
      startDate: "2026-04-01",
      endDate: "2026-06-30",
      status: "active",
      targetMetrics: { impressions: 10000 },
      payout: { amount: 500, currency: "USD", paid: true, paid_at: "2026-05-15", invoice_ref: null },
      created_at: "2026-04-01T00:00:00.000Z",
    });
  });

  test("emits base64 nextStartKey when LastEvaluatedKey is present", async () => {
    mockDdbSend.mockResolvedValue({
      Items: [campaignRow("c-1", "Campaign", "2026-05-01T00:00:00.000Z")],
      LastEvaluatedKey: marshall({ pk: "CAMPAIGN#c-1", sk: "METADATA" }),
    });
    const res = await handler({ queryStringParameters: { limit: "1" } });
    const body = JSON.parse(res.body);
    expect(body.nextStartKey).toEqual(expect.any(String));
    expect(Buffer.from(body.nextStartKey, "base64").toString("utf8")).toMatch(/CAMPAIGN#/);
  });

  test("decodes provided startKey and passes it to Scan", async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    const decoded = { pk: "CAMPAIGN#prior", sk: "METADATA" };
    const startKey = Buffer.from(JSON.stringify(marshall(decoded))).toString("base64");

    await handler({ queryStringParameters: { startKey } });

    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    const scanInput = mockDdbSend.mock.calls[0][0].input;
    expect(scanInput.ExclusiveStartKey).toEqual(marshall(decoded));
  });

  test("includes vendorId in FilterExpression when filter param is set", async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    await handler({ queryStringParameters: { vendorId: VENDOR_ULID_A } });

    const scanInput = mockDdbSend.mock.calls[0][0].input;
    expect(scanInput.FilterExpression).toContain("vendorId = :vendorId");
    expect(scanInput.ExpressionAttributeValues[":vendorId"]).toEqual({ S: VENDOR_ULID_A });
  });

  test("includes #status in FilterExpression when status param is set", async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    await handler({ queryStringParameters: { status: "completed" } });

    const scanInput = mockDdbSend.mock.calls[0][0].input;
    expect(scanInput.FilterExpression).toContain("#status = :status");
    expect(scanInput.ExpressionAttributeNames["#status"]).toBe("status");
    expect(scanInput.ExpressionAttributeValues[":status"]).toEqual({ S: "completed" });
  });

  test("combines vendorId and status filters", async () => {
    mockDdbSend.mockResolvedValue({
      Items: [
        campaignRow("c-1", "Match", "2026-05-01T00:00:00.000Z", {
          vendorId: VENDOR_ULID_B,
          status: "draft",
        }),
      ],
    });
    const res = await handler({ queryStringParameters: { vendorId: VENDOR_ULID_B, status: "draft" } });
    expect(res.statusCode).toBe(200);
    const scanInput = mockDdbSend.mock.calls[0][0].input;
    expect(scanInput.FilterExpression).toContain("vendorId = :vendorId");
    expect(scanInput.FilterExpression).toContain("#status = :status");
  });

  test("loops Scan when FilterExpression returns a partial page", async () => {
    mockDdbSend
      .mockResolvedValueOnce({
        Items: [campaignRow("c-1", "One", "2026-05-01T00:00:00.000Z")],
        LastEvaluatedKey: marshall({ pk: "CAMPAIGN#mid", sk: "METADATA" }),
      })
      .mockResolvedValueOnce({
        Items: [campaignRow("c-2", "Two", "2026-04-01T00:00:00.000Z")],
      });

    const res = await handler({ queryStringParameters: { limit: "10" } });
    expect(mockDdbSend).toHaveBeenCalledTimes(2);
    const body = JSON.parse(res.body);
    expect(body.campaigns.map((c) => c.campaign_id)).toEqual(["c-1", "c-2"]);
    expect(body.nextStartKey).toBeNull();
  });

  test("returns 400 when limit is out of range", async () => {
    const res = await handler({ queryStringParameters: { limit: "1000" } });
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 when limit is not an integer", async () => {
    const res = await handler({ queryStringParameters: { limit: "abc" } });
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 when startKey is not valid base64 JSON", async () => {
    const res = await handler({ queryStringParameters: { startKey: "not-base64-json" } });
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 when vendorId is not a ULID", async () => {
    const res = await handler({ queryStringParameters: { vendorId: "not-a-ulid" } });
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 when status is not in the allowed set", async () => {
    const res = await handler({ queryStringParameters: { status: "archived" } });
    expect(res.statusCode).toBe(400);
  });
});
