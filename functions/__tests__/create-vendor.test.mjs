import { jest } from "@jest/globals";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";

const { handler } = await import("../create-vendor.mjs");

describe("create-vendor", () => {
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

    test("returns 400 when name is whitespace", async () => {
      const res = await invoke({ name: "  " });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when contact_email is malformed", async () => {
      const res = await invoke({ name: "Acme", contact_email: "not-an-email" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/email/);
    });

    test("returns 400 when website is missing scheme", async () => {
      const res = await invoke({ name: "Acme", website: "acme.com" });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/http/);
    });

    test("returns 400 when tags is not an array", async () => {
      const res = await invoke({ name: "Acme", tags: "tag1,tag2" });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 when a tag is too long", async () => {
      const res = await invoke({ name: "Acme", tags: ["x".repeat(51)] });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("happy path", () => {
    test("creates a vendor with only name and returns 201", async () => {
      const res = await invoke({ name: "Acme" });
      expect(res.statusCode).toBe(201);

      const body = JSON.parse(res.body);
      expect(body.vendor_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(body.name).toBe("Acme");
      expect(body.website).toBeNull();
      expect(body.tags).toEqual([]);

      const item = unmarshall(mockDdbSend.mock.calls[0][0].input.Item);
      expect(item.pk).toBe(`VENDOR#${body.vendor_id}`);
      expect(item.sk).toBe("METADATA");
      expect(item.entity).toBe("Vendor");
      expect(mockDdbSend.mock.calls[0][0].input.ConditionExpression).toMatch(/attribute_not_exists/);
    });

    test("stores all provided fields", async () => {
      const res = await invoke({
        name: "AcmeCorp",
        website: "https://acme.com",
        contact_name: "Alex",
        contact_email: "alex@acme.com",
        payment_terms: "net 30",
        tags: ["partner", "saas"],
        notes: "preferred Q4",
      });
      expect(res.statusCode).toBe(201);

      const body = JSON.parse(res.body);
      expect(body.website).toBe("https://acme.com");
      expect(body.contact_email).toBe("alex@acme.com");
      expect(body.tags).toEqual(["partner", "saas"]);
    });

    test("trims name whitespace", async () => {
      const res = await invoke({ name: "  Acme  " });
      const body = JSON.parse(res.body);
      expect(body.name).toBe("Acme");
    });
  });
});
