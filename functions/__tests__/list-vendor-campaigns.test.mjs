import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient, GetItemCommand, QueryCommand } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";

const { handler } = await import("../list-vendor-campaigns.mjs");

describe("list-vendor-campaigns", () => {
  let mockDdbSend;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;
    jest.clearAllMocks();
  });

  const invoke = (vendorId) => handler({ pathParameters: { vendorId } });

  test("returns 400 when vendorId is missing", async () => {
    const res = await handler({ pathParameters: {} });
    expect(res.statusCode).toBe(400);
  });

  test("returns 404 when the vendor doesn't exist", async () => {
    mockDdbSend.mockImplementation((cmd) => {
      if (cmd instanceof GetItemCommand) return Promise.resolve({});
      return Promise.resolve({ Items: [] });
    });

    const res = await invoke("01HV0EXAMPLE0000000000000A");
    expect(res.statusCode).toBe(404);
  });

  test("returns campaigns sorted by created_at desc", async () => {
    mockDdbSend.mockImplementation((cmd) => {
      if (cmd instanceof GetItemCommand) {
        return Promise.resolve({ Item: marshall({ pk: "VENDOR#01HV0EXAMPLE0000000000000A" }) });
      }
      if (cmd instanceof QueryCommand) {
        return Promise.resolve({
          Items: [
            marshall({
              campaignId: "01HV0EXAMPLE0000000000000B",
              vendorId: "01HV0EXAMPLE0000000000000A",
              name: "Older",
              status: "active",
              createdAt: "2026-01-01T00:00:00.000Z",
            }),
            marshall({
              campaignId: "01HV0EXAMPLE0000000000000C",
              vendorId: "01HV0EXAMPLE0000000000000A",
              name: "Newer",
              status: "active",
              createdAt: "2026-05-01T00:00:00.000Z",
            }),
          ],
        });
      }
      return Promise.resolve({});
    });

    const res = await invoke("01HV0EXAMPLE0000000000000A");
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.vendor_id).toBe("01HV0EXAMPLE0000000000000A");
    expect(body.campaigns.length).toBe(2);
    expect(body.campaigns[0].name).toBe("Newer");
    expect(body.campaigns[1].name).toBe("Older");
  });

  test("returns empty list when vendor exists but has no campaigns", async () => {
    mockDdbSend.mockImplementation((cmd) => {
      if (cmd instanceof GetItemCommand) {
        return Promise.resolve({ Item: marshall({ pk: "VENDOR#01HV0EXAMPLE0000000000000A" }) });
      }
      return Promise.resolve({ Items: [] });
    });

    const res = await invoke("01HV0EXAMPLE0000000000000A");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).campaigns).toEqual([]);
  });
});
