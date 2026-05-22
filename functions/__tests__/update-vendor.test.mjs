import { jest } from "@jest/globals";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";

const { handler } = await import("../update-vendor.mjs");

describe("update-vendor", () => {
  let mockDdbSend;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;
    jest.clearAllMocks();
  });

  const invoke = (vendorId, body) => handler({
    pathParameters: { vendorId },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  test("returns 400 when vendorId is missing", async () => {
    const res = await handler({ pathParameters: {}, body: "{}" });
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 when body is empty", async () => {
    const res = await invoke("01HV0EXAMPLE0000000000000A", {});
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/at least one/);
  });

  test("returns 404 when the vendor doesn't exist", async () => {
    const err = new Error("conditional check failed");
    err.name = "ConditionalCheckFailedException";
    mockDdbSend.mockRejectedValue(err);

    const res = await invoke("01HV0EXAMPLE0000000000000A", { name: "Renamed" });
    expect(res.statusCode).toBe(404);
  });

  test("happy path: updates fields and returns the new record", async () => {
    mockDdbSend.mockResolvedValue({
      Attributes: marshall({
        pk: "VENDOR#01HV0EXAMPLE0000000000000A",
        sk: "METADATA",
        vendorId: "01HV0EXAMPLE0000000000000A",
        name: "Renamed",
        website: "https://new.example.com",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
      }),
    });

    const res = await invoke("01HV0EXAMPLE0000000000000A", {
      name: "Renamed",
      website: "https://new.example.com",
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.name).toBe("Renamed");
    expect(body.website).toBe("https://new.example.com");

    const callInput = mockDdbSend.mock.calls[0][0].input;
    expect(callInput.UpdateExpression).toMatch(/SET .*#updatedAt = :updatedAt/);
    expect(callInput.ConditionExpression).toMatch(/attribute_exists/);
  });

  test("null value moves a field to the REMOVE clause", async () => {
    mockDdbSend.mockResolvedValue({
      Attributes: marshall({
        pk: "VENDOR#01HV0EXAMPLE0000000000000A",
        sk: "METADATA",
        vendorId: "01HV0EXAMPLE0000000000000A",
        name: "Acme",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
      }),
    });

    const res = await invoke("01HV0EXAMPLE0000000000000A", { contact_email: null });
    expect(res.statusCode).toBe(200);

    const callInput = mockDdbSend.mock.calls[0][0].input;
    expect(callInput.UpdateExpression).toMatch(/REMOVE .*#contact_email/);
    // values map should still hold :updatedAt but not :contact_email
    const values = unmarshall(callInput.ExpressionAttributeValues);
    expect(values[":updatedAt"]).toEqual(expect.any(String));
    expect(values[":contact_email"]).toBeUndefined();
  });
});
