import { jest } from "@jest/globals";

const { DynamoDBClient, QueryCommand, DeleteItemCommand } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";

const { handler } = await import("../delete-vendor.mjs");

describe("delete-vendor", () => {
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

  test("returns 409 when linked campaigns exist", async () => {
    mockDdbSend.mockImplementation((cmd) => {
      if (cmd instanceof QueryCommand) return Promise.resolve({ Count: 3 });
      return Promise.resolve({});
    });

    const res = await invoke("01HV0EXAMPLE0000000000000A");
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toMatch(/3 linked campaign/);
  });

  test("returns 204 when the delete succeeds", async () => {
    mockDdbSend.mockImplementation((cmd) => {
      if (cmd instanceof QueryCommand) return Promise.resolve({ Count: 0 });
      if (cmd instanceof DeleteItemCommand) return Promise.resolve({});
      return Promise.resolve({});
    });

    const res = await invoke("01HV0EXAMPLE0000000000000A");
    expect(res.statusCode).toBe(204);
  });

  test("returns 404 when the vendor doesn't exist", async () => {
    const err = new Error("conditional check failed");
    err.name = "ConditionalCheckFailedException";

    mockDdbSend.mockImplementation((cmd) => {
      if (cmd instanceof QueryCommand) return Promise.resolve({ Count: 0 });
      if (cmd instanceof DeleteItemCommand) return Promise.reject(err);
      return Promise.resolve({});
    });

    const res = await invoke("01HV0EXAMPLE0000000000000A");
    expect(res.statusCode).toBe(404);
  });
});
