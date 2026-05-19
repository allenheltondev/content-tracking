import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient, GetItemCommand } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";
process.env.NEWSLETTER_API_BASE_URL = "https://example.execute-api.us-east-1.amazonaws.com/public";
process.env.NEWSLETTER_MINT_API_KEY = "test-mint-key";

const { handler } = await import("../get-campaign-link-analytics.mjs");

const linkRow = marshall({
  pk: "CAMPAIGN#camp_abc",
  sk: "LINK#01HXLA",
  campaignId: "camp_abc",
  linkId: "01HXLA",
  code: "aB3xKp",
  shortUrl: "https://rdyset.click/c/aB3xKp",
  role: "social_promo",
  platform: "linkedin",
  url: "https://readysetcloud.io/some-post",
  expiresAt: "2028-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const validParams = { campaignId: "camp_abc", linkId: "01HXLA" };

describe("get-campaign-link-analytics", () => {
  let mockDdbSend;
  let fetchSpy;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;
    fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: "aB3xKp",
        total_clicks: 42,
        by_day: { "2026-05-18": 42 },
        by_src: { linkedin: 40, web: 2 },
        first_click_at: "2026-05-18T08:00:00.000Z",
        last_click_at: "2026-05-18T23:00:00.000Z",
      }),
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("returns 400 when path params missing", async () => {
    expect((await handler({})).statusCode).toBe(400);
    expect((await handler({ pathParameters: { campaignId: "x" } })).statusCode).toBe(400);
    expect((await handler({ pathParameters: { linkId: "y" } })).statusCode).toBe(400);
  });

  test("returns 404 when link is not in this campaign", async () => {
    mockDdbSend.mockResolvedValueOnce({});
    const res = await handler({ pathParameters: validParams });
    expect(res.statusCode).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("looks up link, calls upstream analytics, returns combined response", async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: linkRow });

    const res = await handler({ pathParameters: validParams });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.campaign_id).toBe("camp_abc");
    expect(body.link_id).toBe("01HXLA");
    expect(body.code).toBe("aB3xKp");
    expect(body.role).toBe("social_promo");
    expect(body.platform).toBe("linkedin");
    expect(body.analytics.total_clicks).toBe(42);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [callUrl, callOpts] = fetchSpy.mock.calls[0];
    expect(callUrl).toBe(`${process.env.NEWSLETTER_API_BASE_URL}/links/aB3xKp/analytics`);
    expect(callOpts.method).toBe("GET");
    expect(callOpts.headers["Authorization"]).toBe("test-mint-key");
  });

  test("returns 502 when upstream fails", async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: linkRow });
    fetchSpy.mockRejectedValueOnce(new Error("ENOTFOUND"));

    const res = await handler({ pathParameters: validParams });
    expect(res.statusCode).toBe(502);
  });

  test("returns 502 when upstream returns non-2xx", async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: linkRow });
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => '{"message":"boom"}',
    });

    const res = await handler({ pathParameters: validParams });
    expect(res.statusCode).toBe(502);
  });
});
