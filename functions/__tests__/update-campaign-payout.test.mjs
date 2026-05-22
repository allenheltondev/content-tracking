import { jest } from "@jest/globals";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";

const { handler } = await import("../update-campaign-payout.mjs");

describe("update-campaign-payout", () => {
  let mockDdbSend;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;
    jest.clearAllMocks();
  });

  const invoke = (campaignId, body) => handler({
    pathParameters: { campaignId },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  const successAttrs = (overrides = {}) => marshall({
    pk: "CAMPAIGN#01HV0AABBCCDDEEFFGGHHJJKKM",
    sk: "METADATA",
    entity: "Campaign",
    campaignId: "01HV0AABBCCDDEEFFGGHHJJKKM",
    name: "Launch",
    status: "active",
    createdAt: "2026-05-01T00:00:00.000Z",
    payout: {
      amount: 5000,
      currency: "USD",
      paid: false,
      ...overrides,
    },
  }, { removeUndefinedValues: true });

  describe("validation", () => {
    test("returns 400 when campaignId is missing", async () => {
      const res = await handler({ pathParameters: {}, body: "{}" });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 on invalid JSON", async () => {
      const res = await invoke("CID", "not json");
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when body has no payout fields", async () => {
      const res = await invoke("CID", {});
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/at least one/);
    });

    test("returns 400 when amount is negative", async () => {
      const res = await invoke("CID", { amount: -1 });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when currency is malformed", async () => {
      const res = await invoke("CID", { currency: "usd" });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when paid_at is not a date", async () => {
      const res = await invoke("CID", { paid: true, paid_at: "yesterday" });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("not found", () => {
    test("returns 404 when the campaign doesn't exist", async () => {
      const err = new Error();
      err.name = "ConditionalCheckFailedException";
      mockDdbSend.mockRejectedValue(err);

      const res = await invoke("01HV0AABBCCDDEEFFGGHHJJKKM", { amount: 5000 });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("happy path", () => {
    test("sets the initial payout fields", async () => {
      mockDdbSend.mockResolvedValue({ Attributes: successAttrs({ amount: 7500 }) });
      const res = await invoke("01HV0AABBCCDDEEFFGGHHJJKKM", { amount: 7500, currency: "USD" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.payout.amount).toBe(7500);

      const callInput = mockDdbSend.mock.calls[0][0].input;
      expect(callInput.UpdateExpression).toMatch(/SET #payout = if_not_exists/);
      expect(callInput.UpdateExpression).toMatch(/#payout\.#amount = :amount/);
    });

    test("paid=true with no paid_at defaults paid_at to today", async () => {
      mockDdbSend.mockResolvedValue({
        Attributes: successAttrs({ paid: true, paid_at: new Date().toISOString().slice(0, 10) }),
      });

      const res = await invoke("01HV0AABBCCDDEEFFGGHHJJKKM", { paid: true });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.payout.paid).toBe(true);
      expect(body.payout.paid_at).toBe(new Date().toISOString().slice(0, 10));

      const callInput = mockDdbSend.mock.calls[0][0].input;
      expect(callInput.UpdateExpression).toMatch(/#payout\.#paid_at = :paid_at/);
    });

    test("paid=false with no paid_at clears paid_at via REMOVE", async () => {
      mockDdbSend.mockResolvedValue({
        Attributes: successAttrs({ paid: false, paid_at: undefined }),
      });

      const res = await invoke("01HV0AABBCCDDEEFFGGHHJJKKM", { paid: false });
      expect(res.statusCode).toBe(200);

      const callInput = mockDdbSend.mock.calls[0][0].input;
      expect(callInput.UpdateExpression).toMatch(/REMOVE #payout\.#paid_at/);
    });

    test("explicit null invoice_ref moves to REMOVE", async () => {
      mockDdbSend.mockResolvedValue({ Attributes: successAttrs() });
      const res = await invoke("01HV0AABBCCDDEEFFGGHHJJKKM", { invoice_ref: null });
      expect(res.statusCode).toBe(200);

      const callInput = mockDdbSend.mock.calls[0][0].input;
      expect(callInput.UpdateExpression).toMatch(/REMOVE #payout\.#invoice_ref/);
      const values = unmarshall(callInput.ExpressionAttributeValues);
      expect(values[":invoice_ref"]).toBeUndefined();
    });
  });
});
