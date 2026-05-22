import { jest } from "@jest/globals";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient, UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";

const { handler } = await import("../update-campaign-link.mjs");

const baseLinkAttrs = () => marshall({
  pk: "CAMPAIGN#camp_abc",
  sk: "LINK#01HV0LINK0000000000000000A",
  entity: "Link",
  campaignId: "camp_abc",
  linkId: "01HV0LINK0000000000000000A",
  code: "aB3xKp",
  shortUrl: "https://rdyset.click/c/aB3xKp",
  role: "main",
  platform: "readysetcloud",
  url: "https://readysetcloud.io/some-post",
  notes: "first version",
  src: "linkedin",
  expiresAt: "2028-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-05-02T00:00:00.000Z",
});

const invoke = (body, { campaignId = "camp_abc", linkId = "01HV0LINK0000000000000000A" } = {}) => handler({
  pathParameters: { campaignId, linkId },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("update-campaign-link", () => {
  let mockDdbSend;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;
    jest.clearAllMocks();
  });

  describe("validation", () => {
    test("returns 400 when campaignId is missing", async () => {
      const res = await handler({ pathParameters: { linkId: "01HV0LINK0000000000000000A" }, body: "{}" });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when linkId is missing", async () => {
      const res = await handler({ pathParameters: { campaignId: "camp_abc" }, body: "{}" });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when body is missing", async () => {
      const res = await handler({ pathParameters: { campaignId: "camp_abc", linkId: "01HV0LINK0000000000000000A" } });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 for invalid JSON body", async () => {
      const res = await invoke("{not json");
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 for empty object body", async () => {
      const res = await invoke({});
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/at least one/);
    });

    test("returns 400 when notes is not a string", async () => {
      const res = await invoke({ notes: 123 });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/notes/);
    });

    test("returns 400 when notes is too long", async () => {
      const res = await invoke({ notes: "x".repeat(1001) });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when src is too long", async () => {
      const res = await invoke({ src: "x".repeat(65) });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when src is empty string", async () => {
      const res = await invoke({ src: "" });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when expires_at is not a valid date", async () => {
      const res = await invoke({ expires_at: "not-a-date" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/expires_at/);
    });

    test("none of validation invokes Dynamo", async () => {
      await invoke({ notes: 123 });
      expect(mockDdbSend).not.toHaveBeenCalled();
    });
  });

  describe("immutable fields", () => {
    const cases = [
      { code: "newcode" },
      { short_url: "https://other" },
      { url: "https://other.example" },
      { role: "cross_post" },
      { platform: "medium" },
      { link_id: "spoofed" },
      { campaign_id: "spoofed" },
      { created_at: "2099-01-01T00:00:00.000Z" },
      { shortUrl: "https://snake-case-spoof" },
    ];
    for (const c of cases) {
      const [key] = Object.keys(c);
      test(`returns 400 when caller tries to set "${key}"`, async () => {
        const res = await invoke(c);
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).message).toMatch(/immutable/);
        expect(mockDdbSend).not.toHaveBeenCalled();
      });
    }

    test("rejects unknown fields with a clear message", async () => {
      const res = await invoke({ totally_made_up: "x" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/not editable/);
    });
  });

  describe("happy path", () => {
    test("updates notes and src and returns the new record", async () => {
      const updated = baseLinkAttrs();
      updated.notes = { S: "new notes" };
      updated.src = { S: "twitter" };
      mockDdbSend.mockResolvedValue({ Attributes: updated });

      const res = await invoke({ notes: "new notes", src: "twitter" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.notes).toBe("new notes");
      expect(body.src).toBe("twitter");
      expect(body.code).toBe("aB3xKp");
      expect(body.link_id).toBe("01HV0LINK0000000000000000A");
      expect(body.campaign_id).toBe("camp_abc");

      expect(mockDdbSend).toHaveBeenCalledTimes(1);
      const cmd = mockDdbSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(UpdateItemCommand);
      expect(cmd.input.UpdateExpression).toMatch(/SET .*#notes = :notes.*#src = :src.*#updatedAt = :updatedAt/);
      expect(cmd.input.UpdateExpression).not.toMatch(/REMOVE/);
      expect(cmd.input.ConditionExpression).toMatch(/attribute_exists/);
      const key = unmarshall(cmd.input.Key);
      expect(key.pk).toBe("CAMPAIGN#camp_abc");
      expect(key.sk).toBe("LINK#01HV0LINK0000000000000000A");
    });

    test("maps expires_at to the expiresAt attribute", async () => {
      const updated = baseLinkAttrs();
      updated.expiresAt = { S: "2030-06-15T12:00:00.000Z" };
      mockDdbSend.mockResolvedValue({ Attributes: updated });

      const res = await invoke({ expires_at: "2030-06-15T12:00:00.000Z" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).expires_at).toBe("2030-06-15T12:00:00.000Z");

      const cmd = mockDdbSend.mock.calls[0][0];
      expect(cmd.input.UpdateExpression).toMatch(/#expiresAt = :expiresAt/);
      expect(cmd.input.ExpressionAttributeNames["#expiresAt"]).toBe("expiresAt");
    });

    test("null value moves a nullable field to the REMOVE clause", async () => {
      const updated = baseLinkAttrs();
      delete updated.notes;
      mockDdbSend.mockResolvedValue({ Attributes: updated });

      const res = await invoke({ notes: null });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).notes).toBeNull();

      const cmd = mockDdbSend.mock.calls[0][0];
      expect(cmd.input.UpdateExpression).toMatch(/REMOVE #notes/);
      const values = unmarshall(cmd.input.ExpressionAttributeValues);
      expect(values[":notes"]).toBeUndefined();
      expect(values[":updatedAt"]).toEqual(expect.any(String));
    });
  });

  describe("not found", () => {
    test("returns 404 when DynamoDB throws ConditionalCheckFailedException", async () => {
      const err = new Error("conditional check failed");
      err.name = "ConditionalCheckFailedException";
      mockDdbSend.mockRejectedValue(err);

      const res = await invoke({ notes: "anything" });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toMatch(/Link 01HV0LINK0000000000000000A/);
    });
  });
});
