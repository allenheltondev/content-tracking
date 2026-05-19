import { jest } from "@jest/globals";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");

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
      expect(body.startDate).toBeNull();

      const item = unmarshall(mockDdbSend.mock.calls[0][0].input.Item);
      expect(item.pk).toBe(`CAMPAIGN#${body.campaign_id}`);
      expect(item.sk).toBe("METADATA");
      expect(item.entity).toBe("Campaign");
      expect(mockDdbSend.mock.calls[0][0].input.ConditionExpression).toMatch(/attribute_not_exists/);
    });

    test("stores all provided fields", async () => {
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
      expect(body.startDate).toBe("2026-04-01");
      expect(body.endDate).toBe("2026-06-30");
      expect(body.status).toBe("draft");
      expect(body.targetMetrics).toEqual({ impressions: 50000 });

      const item = unmarshall(mockDdbSend.mock.calls[0][0].input.Item);
      expect(item.sponsor).toBe("AcmeCorp");
      expect(item.targetMetrics).toEqual({ impressions: 50000 });
    });

    test("trims whitespace from name", async () => {
      const res = await invoke({ name: "  hello  " });
      const body = JSON.parse(res.body);
      expect(body.name).toBe("hello");
    });
  });
});
