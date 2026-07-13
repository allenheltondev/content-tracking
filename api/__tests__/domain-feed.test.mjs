import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { ConditionalCheckFailedException } = await import("@aws-sdk/client-dynamodb");
const {
  feedSourceKey,
  radarPrefsKey,
  createFeedSource,
  listFeedSources,
  getFeedSource,
  updateFeedSource,
  deleteFeedSource,
  recordFeedFetch,
  getRadarPrefs,
  putRadarPrefs,
} = await import("../domain/feed.mjs");
const { NotFoundError } = await import("../services/errors.mjs");

const input = (mockSend, i = 0) => mockSend.mock.calls[i][0].input;
const TENANT = "tenant-sub-1";

describe("domain/feed", () => {
  let mockSend;
  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  test("feedSourceKey scopes under the tenant partition", () => {
    expect(feedSourceKey(TENANT, "F1")).toEqual({ pk: `TENANT#${TENANT}`, sk: "FEED#SOURCE#F1" });
  });

  test("createFeedSource writes a FeedSource with a ULID id", async () => {
    mockSend.mockResolvedValue({});
    const item = await createFeedSource(TENANT, { url: "https://a.com/feed", title: "A" });
    expect(item.entity).toBe("FeedSource");
    expect(item.url).toBe("https://a.com/feed");
    expect(item.title).toBe("A");
    expect(item.feedId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(item.sk).toBe(`FEED#SOURCE#${item.feedId}`);
    expect(input(mockSend).Item.entity).toBe("FeedSource");
  });

  test("createFeedSource omits title when not given", async () => {
    mockSend.mockResolvedValue({});
    const item = await createFeedSource(TENANT, { url: "https://a.com/feed" });
    expect(item.title).toBeUndefined();
    expect(input(mockSend).Item.title).toBeUndefined();
  });

  test("listFeedSources pages the prefix and returns newest-first", async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [{ feedId: "01AAA", url: "a" }, { feedId: "01CCC", url: "c" }],
        LastEvaluatedKey: { k: 1 },
      })
      .mockResolvedValueOnce({ Items: [{ feedId: "01BBB", url: "b" }] });

    const items = await listFeedSources(TENANT);
    expect(items.map((i) => i.feedId)).toEqual(["01CCC", "01BBB", "01AAA"]);
    expect(mockSend).toHaveBeenCalledTimes(2);
    // Second call carried the pagination cursor.
    expect(input(mockSend, 1).ExclusiveStartKey).toEqual({ k: 1 });
  });

  test("getFeedSource returns null when absent", async () => {
    mockSend.mockResolvedValue({});
    expect(await getFeedSource(TENANT, "F1")).toBeNull();
  });

  test("updateFeedSource sets provided fields and clears nulls", async () => {
    mockSend.mockResolvedValue({ Attributes: { feedId: "F1", muted: true } });
    const res = await updateFeedSource(TENANT, "F1", { title: null, muted: true });
    expect(res.muted).toBe(true);
    const cmd = input(mockSend);
    expect(cmd.UpdateExpression).toMatch(/REMOVE #title/);
    expect(cmd.UpdateExpression).toMatch(/#muted = :muted/);
    expect(cmd.ConditionExpression).toBe("attribute_exists(sk)");
  });

  test("updateFeedSource maps a missing row to NotFound", async () => {
    mockSend.mockRejectedValue(new ConditionalCheckFailedException({ message: "nope", $metadata: {} }));
    await expect(updateFeedSource(TENANT, "F1", { muted: true })).rejects.toThrow(NotFoundError);
  });

  test("deleteFeedSource is conditional and maps missing to NotFound", async () => {
    mockSend.mockResolvedValue({});
    await deleteFeedSource(TENANT, "F1");
    expect(input(mockSend).ConditionExpression).toBe("attribute_exists(sk)");

    mockSend.mockRejectedValue(new ConditionalCheckFailedException({ message: "nope", $metadata: {} }));
    await expect(deleteFeedSource(TENANT, "F1")).rejects.toThrow(NotFoundError);
  });

  test("recordFeedFetch stamps ok status and clears prior error", async () => {
    mockSend.mockResolvedValue({});
    await recordFeedFetch(TENANT, "F1", { ok: true, itemCount: 5 });
    const cmd = input(mockSend);
    expect(cmd.UpdateExpression).toMatch(/lastStatus = :ok/);
    expect(cmd.UpdateExpression).toMatch(/REMOVE lastError/);
    expect(cmd.ExpressionAttributeValues[":count"]).toBe(5);
    expect(cmd.ConditionExpression).toBe("attribute_exists(sk)");
  });

  test("recordFeedFetch stamps error status with a truncated message", async () => {
    mockSend.mockResolvedValue({});
    await recordFeedFetch(TENANT, "F1", { ok: false, error: "x".repeat(999) });
    const cmd = input(mockSend);
    expect(cmd.UpdateExpression).toMatch(/lastError = :error/);
    expect(cmd.ExpressionAttributeValues[":error"].length).toBe(500);
  });

  test("radarPrefsKey is the per-tenant singleton", () => {
    expect(radarPrefsKey(TENANT)).toEqual({ pk: `TENANT#${TENANT}`, sk: "FEED#PREFS" });
  });

  test("getRadarPrefs returns null when unset", async () => {
    mockSend.mockResolvedValue({});
    expect(await getRadarPrefs(TENANT)).toBeNull();
  });

  test("putRadarPrefs upserts provided fields and clears nulls", async () => {
    mockSend.mockResolvedValue({ Attributes: { interests: ["serverless"], defaultPlatform: null } });
    const res = await putRadarPrefs(TENANT, {
      interests: ["serverless"],
      avoid: [],
      defaultPlatform: null,
      audience: "senior devs",
    });
    expect(res.interests).toEqual(["serverless"]);
    const cmd = input(mockSend);
    expect(cmd.Key).toEqual({ pk: `TENANT#${TENANT}`, sk: "FEED#PREFS" });
    expect(cmd.UpdateExpression).toMatch(/#interests = :interests/);
    expect(cmd.UpdateExpression).toMatch(/REMOVE #defaultPlatform/);
    expect(cmd.ExpressionAttributeValues[":entity"]).toBe("ContentRadarPrefs");
  });
});
