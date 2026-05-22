import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";

const { handler } = await import("../list-vendors.mjs");

describe("list-vendors", () => {
  let mockDdbSend;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;
    jest.clearAllMocks();
  });

  const vendorRow = (id, name) => marshall({
    pk: `VENDOR#${id}`,
    sk: "METADATA",
    entity: "Vendor",
    vendorId: id,
    name,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  });

  test("returns empty list when no vendors exist", async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    const res = await handler({});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ vendors: [], nextStartKey: null });
  });

  test("returns vendors and no pagination token when scan completes", async () => {
    mockDdbSend.mockResolvedValue({
      Items: [
        vendorRow("01HV0EXAMPLE0000000000000A", "Acme"),
        vendorRow("01HV0EXAMPLE0000000000000B", "Beta"),
      ],
    });
    const res = await handler({});
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.vendors.length).toBe(2);
    expect(body.vendors[0].name).toBe("Acme");
    expect(body.nextStartKey).toBeNull();
  });

  test("emits base64 nextStartKey when LastEvaluatedKey is present", async () => {
    mockDdbSend.mockResolvedValue({
      Items: [vendorRow("01HV0EXAMPLE0000000000000A", "Acme")],
      LastEvaluatedKey: marshall({ pk: "VENDOR#x", sk: "METADATA" }),
    });
    const res = await handler({});
    const body = JSON.parse(res.body);
    expect(body.nextStartKey).toEqual(expect.any(String));
    expect(Buffer.from(body.nextStartKey, "base64").toString("utf8")).toMatch(/VENDOR#/);
  });

  test("returns 400 when limit is out of range", async () => {
    const res = await handler({ queryStringParameters: { limit: "1000" } });
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 when startKey is not valid base64 JSON", async () => {
    const res = await handler({ queryStringParameters: { startKey: "not-base64-json" } });
    expect(res.statusCode).toBe(400);
  });
});
