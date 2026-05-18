import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient, QueryCommand } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";

const { handler } = await import("../get-campaign.mjs");

const metadataRow = marshall({
  pk: "CAMPAIGN#camp_abc",
  sk: "METADATA",
  entity: "Campaign",
  campaignId: "camp_abc",
  name: "Test campaign",
  sponsor: "AcmeCorp",
  startDate: "2026-04-01",
  endDate: "2026-06-30",
  status: "active",
  targetMetrics: { impressions: 50000 },
  createdAt: "2026-01-01T00:00:00.000Z",
});

const linkRow = (linkId, role, platform, createdAt) => marshall({
  pk: "CAMPAIGN#camp_abc",
  sk: `LINK#${linkId}`,
  entity: "Link",
  campaignId: "camp_abc",
  linkId,
  code: `code_${linkId}`.slice(0, 6),
  shortUrl: `https://rdyset.click/c/code_${linkId}`.slice(0, 40),
  role,
  platform,
  url: `https://example.com/${linkId}`,
  expiresAt: "2028-01-01T00:00:00.000Z",
  createdAt,
});

describe("get-campaign", () => {
  let mockDdbSend;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;
    jest.clearAllMocks();
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

  test("returns campaign + links sorted by created_at", async () => {
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        linkRow("01HXLB", "social_promo", "twitter", "2026-04-12T00:00:00.000Z"),
        metadataRow,
        linkRow("01HXLA", "main", "readysetcloud", "2026-04-10T00:00:00.000Z"),
      ],
    });

    const res = await handler({ pathParameters: { campaignId: "camp_abc" } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.campaign.campaign_id).toBe("camp_abc");
    expect(body.campaign.name).toBe("Test campaign");
    expect(body.campaign.sponsor).toBe("AcmeCorp");
    expect(body.links).toHaveLength(2);
    expect(body.links[0].link_id).toBe("01HXLA");
    expect(body.links[1].link_id).toBe("01HXLB");

    const queryCmd = mockDdbSend.mock.calls[0][0];
    expect(queryCmd).toBeInstanceOf(QueryCommand);
  });

  test("paginates via LastEvaluatedKey", async () => {
    let calls = 0;
    mockDdbSend.mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve({
          Items: [metadataRow],
          LastEvaluatedKey: { pk: { S: "x" } },
        });
      }
      return Promise.resolve({
        Items: [linkRow("01HXLA", "main", "readysetcloud", "2026-04-10T00:00:00.000Z")],
      });
    });

    const res = await handler({ pathParameters: { campaignId: "camp_abc" } });
    expect(res.statusCode).toBe(200);
    expect(calls).toBe(2);
    expect(JSON.parse(res.body).links).toHaveLength(1);
  });
});
