import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";
process.env.NEWSLETTER_API_BASE_URL = "https://example.execute-api.us-east-1.amazonaws.com/public";
process.env.NEWSLETTER_MINT_API_KEY = "test-mint-key";

const { handler } = await import("../get-campaign-analytics.mjs");

const metadataRow = marshall({
  pk: "CAMPAIGN#camp_abc",
  sk: "METADATA",
  entity: "Campaign",
  campaignId: "camp_abc",
  name: "Test campaign",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const linkRow = (linkId, role, platform, code) => marshall({
  pk: "CAMPAIGN#camp_abc",
  sk: `LINK#${linkId}`,
  campaignId: "camp_abc",
  linkId,
  code,
  role,
  platform,
  url: `https://example.com/${linkId}`,
});

const analyticsResp = (total, code) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({
    code,
    total_clicks: total,
    by_day: {},
    by_src: {},
    first_click_at: null,
    last_click_at: null,
  }),
});

describe("get-campaign-analytics", () => {
  let mockDdbSend;
  let fetchSpy;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;
    fetchSpy = jest.spyOn(globalThis, "fetch");
    jest.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("returns 400 when campaignId missing", async () => {
    const res = await handler({});
    expect(res.statusCode).toBe(400);
  });

  test("returns 404 when campaign metadata is absent", async () => {
    mockDdbSend.mockResolvedValueOnce({ Items: [] });
    const res = await handler({ pathParameters: { campaignId: "camp_abc" } });
    expect(res.statusCode).toBe(404);
  });

  test("returns zeroed rollup when campaign has no links", async () => {
    mockDdbSend.mockResolvedValueOnce({ Items: [metadataRow] });
    const res = await handler({ pathParameters: { campaignId: "camp_abc" } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.link_count).toBe(0);
    expect(body.total_clicks).toBe(0);
    expect(body.links).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("fans out one analytics call per link and aggregates totals + breakdowns", async () => {
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        metadataRow,
        linkRow("01HXLA", "main", "readysetcloud", "AAAAAA"),
        linkRow("01HXLB", "social_promo", "linkedin", "BBBBBB"),
        linkRow("01HXLC", "social_promo", "linkedin", "CCCCCC"),
      ],
    });
    fetchSpy
      .mockResolvedValueOnce(analyticsResp(100, "AAAAAA"))
      .mockResolvedValueOnce(analyticsResp(30, "BBBBBB"))
      .mockResolvedValueOnce(analyticsResp(12, "CCCCCC"));

    const res = await handler({ pathParameters: { campaignId: "camp_abc" } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.link_count).toBe(3);
    expect(body.total_clicks).toBe(142);
    expect(body.by_role).toEqual({ main: 100, social_promo: 42 });
    expect(body.by_platform).toEqual({ readysetcloud: 100, linkedin: 42 });
    expect(body.links).toHaveLength(3);
    expect(body.upstream_failures).toBe(0);
  });

  test("treats per-link upstream failures as zero and reports upstream_failures count", async () => {
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        metadataRow,
        linkRow("01HXLA", "main", "readysetcloud", "AAAAAA"),
        linkRow("01HXLB", "social_promo", "linkedin", "BBBBBB"),
      ],
    });
    fetchSpy
      .mockResolvedValueOnce(analyticsResp(100, "AAAAAA"))
      .mockRejectedValueOnce(new Error("network"));

    const res = await handler({ pathParameters: { campaignId: "camp_abc" } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total_clicks).toBe(100);
    expect(body.upstream_failures).toBe(1);
    const failedLink = body.links.find((l) => l.link_id === "01HXLB");
    expect(failedLink.error).toBeTruthy();
    expect(failedLink.total_clicks).toBe(0);
  });

  test("returns 502 when ALL upstream calls fail", async () => {
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        metadataRow,
        linkRow("01HXLA", "main", "readysetcloud", "AAAAAA"),
      ],
    });
    fetchSpy.mockRejectedValueOnce(new Error("network"));

    const res = await handler({ pathParameters: { campaignId: "camp_abc" } });
    expect(res.statusCode).toBe(502);
  });
});
