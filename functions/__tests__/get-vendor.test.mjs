import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";

const { handler } = await import("../get-vendor.mjs");

describe("get-vendor", () => {
  let mockDdbSend;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;
    jest.clearAllMocks();
  });

  test("returns 400 when vendorId is missing", async () => {
    mockDdbSend.mockResolvedValue({});
    const res = await handler({ pathParameters: {} });
    expect(res.statusCode).toBe(400);
  });

  test("returns 404 when the vendor doesn't exist", async () => {
    mockDdbSend.mockResolvedValue({});
    const res = await handler({ pathParameters: { vendorId: "01HV0EXAMPLE0000000000000Z" } });
    expect(res.statusCode).toBe(404);
  });

  test("returns 200 with the vendor body", async () => {
    mockDdbSend.mockResolvedValue({
      Item: marshall({
        pk: "VENDOR#01HV0EXAMPLE0000000000000Z",
        sk: "METADATA",
        entity: "Vendor",
        vendorId: "01HV0EXAMPLE0000000000000Z",
        name: "Acme",
        website: "https://acme.com",
        tags: ["partner"],
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }),
    });

    const res = await handler({ pathParameters: { vendorId: "01HV0EXAMPLE0000000000000Z" } });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.vendor_id).toBe("01HV0EXAMPLE0000000000000Z");
    expect(body.name).toBe("Acme");
    expect(body.website).toBe("https://acme.com");
    expect(body.tags).toEqual(["partner"]);
    expect(body.contact_email).toBeNull();
  });
});
