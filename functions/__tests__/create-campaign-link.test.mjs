import { jest } from "@jest/globals";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient, GetItemCommand, PutItemCommand } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";
process.env.NEWSLETTER_API_BASE_URL = "https://example.execute-api.us-east-1.amazonaws.com/public";
process.env.NEWSLETTER_MINT_API_KEY = "test-mint-api-key-value";
process.env.SHORT_LINK_BASE = "https://rdyset.click/c";

const { handler } = await import("../create-campaign-link.mjs");

const existingCampaign = marshall({
  pk: "CAMPAIGN#camp_abc",
  sk: "METADATA",
  entity: "Campaign",
  campaignId: "camp_abc",
  name: "Test campaign",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const validLinkBody = {
  role: "main",
  platform: "readysetcloud",
  url: "https://readysetcloud.io/some-post",
};

const validEvent = (body = validLinkBody, campaignId = "camp_abc") => ({
  pathParameters: { campaignId },
  body: JSON.stringify(body),
});

describe("create-campaign-link", () => {
  let mockDdbSend;
  let fetchSpy;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;

    fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: "aB3xKp",
        short_url: "https://rdyset.click/c/aB3xKp",
        expires_at: "2028-01-01T00:00:00.000Z",
      }),
    }));

    jest.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe("validation", () => {
    test("returns 400 when campaignId path param missing", async () => {
      const res = await handler({ body: JSON.stringify(validLinkBody) });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/campaignId/);
    });

    test("returns 400 when body missing", async () => {
      const res = await handler({ pathParameters: { campaignId: "camp_abc" } });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 for invalid JSON body", async () => {
      const res = await handler({ pathParameters: { campaignId: "camp_abc" }, body: "{not json" });
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 for invalid role", async () => {
      const res = await handler(validEvent({ ...validLinkBody, role: "main_event" }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/role/);
    });

    test("returns 400 for missing platform", async () => {
      const { platform, ...rest } = validLinkBody;
      const res = await handler(validEvent(rest));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/platform/);
    });

    test("returns 400 for non-http url", async () => {
      const res = await handler(validEvent({ ...validLinkBody, url: "ftp://example.com" }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/url/);
    });

    test("returns 400 for url over 2048 chars", async () => {
      const longUrl = "https://example.com/" + "a".repeat(2050);
      const res = await handler(validEvent({ ...validLinkBody, url: longUrl }));
      expect(res.statusCode).toBe(400);
    });

    test("returns 400 for invalid expiresInDays", async () => {
      for (const bad of [0, -5, 3.14, 9999, "abc"]) {
        const res = await handler(validEvent({ ...validLinkBody, expiresInDays: bad }));
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).message).toMatch(/expiresInDays/);
      }
    });

    test("none of validation invokes Dynamo or fetch", async () => {
      await handler(validEvent({ ...validLinkBody, role: "garbage" }));
      expect(mockDdbSend).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("campaign existence", () => {
    test("returns 404 when campaign does not exist", async () => {
      mockDdbSend.mockImplementation((cmd) => {
        if (cmd instanceof GetItemCommand) return Promise.resolve({});
        return Promise.resolve({});
      });

      const res = await handler(validEvent());
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toMatch(/Campaign camp_abc/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("happy path", () => {
    beforeEach(() => {
      mockDdbSend.mockImplementation((cmd) => {
        if (cmd instanceof GetItemCommand) return Promise.resolve({ Item: existingCampaign });
        return Promise.resolve({});
      });
    });

    test("mints code via newsletter-service and stores the Link", async () => {
      const res = await handler(validEvent());
      expect(res.statusCode).toBe(201);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [callUrl, callOpts] = fetchSpy.mock.calls[0];
      expect(callUrl).toBe(`${process.env.NEWSLETTER_API_BASE_URL}/links`);
      expect(callOpts.method).toBe("POST");
      expect(callOpts.headers["x-api-key"]).toBe("test-mint-api-key-value");
      const sentBody = JSON.parse(callOpts.body);
      expect(sentBody.url).toBe(validLinkBody.url);
      expect(sentBody.cid).toMatch(/^campaign#camp_abc#link#[0-9A-HJKMNP-TV-Z]{26}$/);

      const body = JSON.parse(res.body);
      expect(body.code).toBe("aB3xKp");
      expect(body.short_url).toBe("https://rdyset.click/c/aB3xKp");
      expect(body.expires_at).toBe("2028-01-01T00:00:00.000Z");
      expect(body.role).toBe("main");

      const puts = mockDdbSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof PutItemCommand);
      expect(puts).toHaveLength(1);
      const item = unmarshall(puts[0].input.Item);
      expect(item.pk).toBe("CAMPAIGN#camp_abc");
      expect(item.sk).toBe(`LINK#${body.link_id}`);
      expect(item.code).toBe("aB3xKp");
      expect(item.shortUrl).toBe("https://rdyset.click/c/aB3xKp");
      expect(item.entity).toBe("Link");
    });

    test("forwards src and expiresInDays to the mint call", async () => {
      await handler(validEvent({
        ...validLinkBody,
        src: "linkedin",
        expiresInDays: 365,
      }));

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(sentBody.src).toBe("linkedin");
      expect(sentBody.expiresInDays).toBe(365);

      const linkPut = mockDdbSend.mock.calls
        .map((c) => c[0])
        .find((c) => c instanceof PutItemCommand);
      const item = unmarshall(linkPut.input.Item);
      expect(item.src).toBe("linkedin");
    });

    test("omits src and expiresInDays from mint call when not provided", async () => {
      await handler(validEvent());
      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(sentBody).not.toHaveProperty("src");
      expect(sentBody).not.toHaveProperty("expiresInDays");
    });
  });

  describe("upstream errors", () => {
    beforeEach(() => {
      mockDdbSend.mockImplementation((cmd) => {
        if (cmd instanceof GetItemCommand) return Promise.resolve({ Item: existingCampaign });
        return Promise.resolve({});
      });
    });

    test("returns 502 when newsletter-service returns 4xx", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"message":"url is required"}',
      });

      const res = await handler(validEvent());
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body).message).toMatch(/Upstream/);

      const puts = mockDdbSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof PutItemCommand);
      expect(puts).toHaveLength(0);
    });

    test("returns 502 when newsletter-service returns 5xx", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => '{"message":"unavailable"}',
      });

      const res = await handler(validEvent());
      expect(res.statusCode).toBe(502);
    });

    test("returns 502 when fetch throws", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("ENOTFOUND"));
      const res = await handler(validEvent());
      expect(res.statusCode).toBe(502);
    });
  });
});
