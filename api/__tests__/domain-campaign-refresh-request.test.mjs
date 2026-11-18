import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const {
  refreshRequestKey,
  recordRefreshRequest,
  listPendingRefreshRequests,
  getRefreshRequest,
  clearRefreshRequest,
  REFRESH_REQUEST_TTL_DAYS,
} = await import("../domain/campaign-refresh-request.mjs");

const TENANT = "tenant-sub-123";
const conditionFailed = () => Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });
const nowSec = () => Math.floor(Date.now() / 1000);

describe("domain/campaign-refresh-request", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
  });

  test("keys live under the tenant partition", () => {
    expect(refreshRequestKey(TENANT, "C1")).toEqual({ pk: `TENANT#${TENANT}`, sk: "REFRESHREQUEST#C1" });
  });

  describe("recordRefreshRequest", () => {
    test("writes a TTL'd request that only replaces a missing or expired one", async () => {
      mockSend.mockResolvedValueOnce({});
      await expect(recordRefreshRequest(TENANT, "C1")).resolves.toBe(true);

      const input = mockSend.mock.calls[0][0].input;
      expect(input.Item).toMatchObject({
        pk: `TENANT#${TENANT}`,
        sk: "REFRESHREQUEST#C1",
        entity: "CampaignRefreshRequest",
        tenantId: TENANT,
        campaignId: "C1",
      });
      expect(Date.parse(input.Item.requestedAt)).not.toBeNaN();
      const ttl = REFRESH_REQUEST_TTL_DAYS * 24 * 60 * 60;
      expect(input.Item.expiresAt).toBeGreaterThanOrEqual(nowSec() + ttl - 2);
      expect(input.Item.expiresAt).toBeLessThanOrEqual(nowSec() + ttl);
      expect(input.ConditionExpression).toBe("attribute_not_exists(pk) OR expiresAt <= :nowSec");
    });

    test("keeps the earlier request when one is already pending", async () => {
      mockSend.mockRejectedValueOnce(conditionFailed());
      await expect(recordRefreshRequest(TENANT, "C1")).resolves.toBe(false);
    });

    test("rethrows other errors", async () => {
      mockSend.mockRejectedValueOnce(new Error("throttled"));
      await expect(recordRefreshRequest(TENANT, "C1")).rejects.toThrow("throttled");
    });
  });

  describe("listPendingRefreshRequests", () => {
    test("reads every page of the tenant's requests, drops expired rows, oldest first", async () => {
      mockSend
        .mockResolvedValueOnce({
          Items: [
            { campaignId: "C2", requestedAt: "2026-11-18T12:00:00.000Z", expiresAt: nowSec() + 100 },
            { campaignId: "GONE", requestedAt: "2026-11-10T12:00:00.000Z", expiresAt: nowSec() - 1 },
          ],
          LastEvaluatedKey: { pk: "p", sk: "s" },
        })
        .mockResolvedValueOnce({
          Items: [{ campaignId: "C1", requestedAt: "2026-11-18T08:00:00.000Z", expiresAt: nowSec() + 100 }],
        });

      const items = await listPendingRefreshRequests(TENANT);
      expect(items.map((i) => i.campaignId)).toEqual(["C1", "C2"]);

      const first = mockSend.mock.calls[0][0].input;
      expect(first.KeyConditionExpression).toBe("pk = :pk AND begins_with(sk, :prefix)");
      expect(first.ExpressionAttributeValues).toEqual({ ":pk": `TENANT#${TENANT}`, ":prefix": "REFRESHREQUEST#" });
      expect(mockSend.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ pk: "p", sk: "s" });
    });

    test("empty when nothing is pending", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });
      await expect(listPendingRefreshRequests(TENANT)).resolves.toEqual([]);
    });
  });

  describe("getRefreshRequest", () => {
    test("returns a live request", async () => {
      const item = { campaignId: "C1", requestedAt: "t", expiresAt: nowSec() + 60 };
      mockSend.mockResolvedValueOnce({ Item: item });
      await expect(getRefreshRequest(TENANT, "C1")).resolves.toEqual(item);
      expect(mockSend.mock.calls[0][0].input.Key).toEqual(refreshRequestKey(TENANT, "C1"));
    });

    test("treats an expired row awaiting TTL deletion as absent", async () => {
      mockSend.mockResolvedValueOnce({ Item: { campaignId: "C1", expiresAt: nowSec() - 60 } });
      await expect(getRefreshRequest(TENANT, "C1")).resolves.toBeNull();
    });

    test("null when missing", async () => {
      mockSend.mockResolvedValueOnce({});
      await expect(getRefreshRequest(TENANT, "C1")).resolves.toBeNull();
    });
  });

  describe("clearRefreshRequest", () => {
    test("deletes only the request the caller read", async () => {
      mockSend.mockResolvedValueOnce({});
      await expect(clearRefreshRequest(TENANT, "C1", "2026-11-18T08:00:00.000Z")).resolves.toBe(true);
      const input = mockSend.mock.calls[0][0].input;
      expect(input.Key).toEqual(refreshRequestKey(TENANT, "C1"));
      expect(input.ConditionExpression).toBe("requestedAt = :requestedAt");
      expect(input.ExpressionAttributeValues).toEqual({ ":requestedAt": "2026-11-18T08:00:00.000Z" });
    });

    test("leaves a newer request in place", async () => {
      mockSend.mockRejectedValueOnce(conditionFailed());
      await expect(clearRefreshRequest(TENANT, "C1", "old")).resolves.toBe(false);
    });
  });
});
