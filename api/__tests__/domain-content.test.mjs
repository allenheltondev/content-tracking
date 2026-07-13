import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const {
  createContent,
  getContent,
  findContent,
  listContentByTenant,
  updateContent,
  deleteContent,
  attachCampaign,
  detachCampaign,
  contentKey,
  publishVariantKey,
  statsKey,
  contentVectorStateKey,
  getContentVectorState,
  putContentVectorState,
  putPublishVariant,
  listPublishVariants,
  putStatsSnapshot,
  listContentStats,
} = await import("../domain/content.mjs");

const input = (mockSend, i = 0) => mockSend.mock.calls[i][0].input;

const TENANT = "tenant-sub-123";

describe("domain/content", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  describe("key helpers", () => {
    test("scope every key under the tenant partition", () => {
      const pk = `TENANT#${TENANT}`;
      expect(contentKey(TENANT, "C1")).toEqual({ pk, sk: "CONTENT#C1" });
      expect(publishVariantKey(TENANT, "C1", "x")).toEqual({ pk, sk: "CONTENT#C1#PUBLISH#x" });
      expect(statsKey(TENANT, "C1", "x", "2026-06-22")).toEqual({ pk, sk: "CONTENT#C1#STATS#x#2026-06-22" });
      expect(contentVectorStateKey(TENANT, "C1")).toEqual({ pk, sk: "CONTENT#C1#VECTORINDEX" });
    });
  });

  describe("createContent", () => {
    test("writes a tenant-scoped Content root with GSI1 keys and seeded links.url", async () => {
      mockSend.mockResolvedValue({});
      const item = await createContent(TENANT, {
        title: "Hello",
        type: "blog",
        source: "owned",
        slug: "hello",
        status: "draft",
        canonicalUrl: "https://readysetcloud.io/blog/hello",
        contentMarkdown: "# hi",
      });

      expect(item.contentId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(item.pk).toBe(`TENANT#${TENANT}`);
      expect(item.sk).toBe(`CONTENT#${item.contentId}`);
      expect(item.entity).toBe("Content");
      expect(item.tenantId).toBe(TENANT);
      expect(item.type).toBe("blog");
      expect(item.source).toBe("owned");
      expect(item.gsi1pk).toBe(`TENANT#${TENANT}#CONTENT`);
      expect(item.gsi1sk).toBe(`${item.createdAt}#${item.contentId}`);
      expect(item.links).toEqual({ url: "https://readysetcloud.io/blog/hello" });
      expect(item.ids).toEqual({});

      expect(input(mockSend).ConditionExpression).toBe("attribute_not_exists(sk)");
    });

    test("structural fields win over client-supplied overrides", async () => {
      mockSend.mockResolvedValue({});
      const item = await createContent(TENANT, {
        title: "x",
        type: "social",
        canonicalUrl: "https://x/y",
        tenantId: "evil-tenant",
        entity: "NotContent",
        pk: "HACK",
      });
      expect(item.tenantId).toBe(TENANT);
      expect(item.entity).toBe("Content");
      expect(item.pk).toBe(`TENANT#${TENANT}`);
    });

    test("attaches a campaign transactionally when campaignId is supplied", async () => {
      // findCampaign (available), then the TransactWrite.
      mockSend.mockResolvedValueOnce({ Item: { campaignId: "CMP1", name: "x" } });
      mockSend.mockResolvedValueOnce({});

      const item = await createContent(TENANT, {
        title: "Sponsored", type: "blog", slug: "sponsored",
        canonicalUrl: "https://x/y", contentMarkdown: "# hi", campaignId: "CMP1",
      });

      expect(item.campaignId).toBe("CMP1");
      const tx = input(mockSend, 1).TransactItems;
      expect(tx).toHaveLength(2);
      // The content root Put and the campaign back-pointer Update.
      expect(tx[0].Put.Item.sk).toBe(`CONTENT#${item.contentId}`);
      expect(tx[0].Put.Item.campaignId).toBe("CMP1");
      expect(tx[1].Update.Key).toEqual({ pk: "CAMPAIGN#CMP1", sk: "METADATA" });
      expect(tx[1].Update.ExpressionAttributeValues[":contentId"]).toBe(item.contentId);
      expect(tx[1].Update.ConditionExpression).toMatch(/attribute_not_exists\(#contentId\)/);
    });

    test("409s when the campaign is already attached to other content", async () => {
      mockSend.mockResolvedValueOnce({ Item: { campaignId: "CMP1", contentId: "OTHER" } });
      await expect(createContent(TENANT, {
        title: "x", type: "blog", slug: "x", canonicalUrl: "https://x/y",
        contentMarkdown: "b", campaignId: "CMP1",
      })).rejects.toThrow(/already attached to another content piece/);
    });

    test("404s when the campaign to attach does not exist", async () => {
      mockSend.mockResolvedValueOnce({}); // findCampaign miss
      await expect(createContent(TENANT, {
        title: "x", type: "blog", slug: "x", canonicalUrl: "https://x/y",
        contentMarkdown: "b", campaignId: "MISSING",
      })).rejects.toThrow(/Campaign MISSING not found/);
    });
  });

  describe("attachCampaign / detachCampaign", () => {
    test("attach writes both sides atomically and returns the updated content", async () => {
      mockSend.mockResolvedValueOnce({ Item: { contentId: "C1" } }); // getContent (exists)
      mockSend.mockResolvedValueOnce({ Item: { campaignId: "CMP1" } }); // findCampaign (available)
      mockSend.mockResolvedValueOnce({}); // TransactWrite
      mockSend.mockResolvedValueOnce({ Item: { contentId: "C1", campaignId: "CMP1" } }); // getContent (read-back)

      const updated = await attachCampaign(TENANT, "C1", "CMP1");
      expect(updated.campaignId).toBe("CMP1");

      const tx = input(mockSend, 2).TransactItems;
      expect(tx[0].Update.Key).toEqual(contentKey(TENANT, "C1"));
      expect(tx[0].Update.ExpressionAttributeValues[":campaignId"]).toBe("CMP1");
      expect(tx[1].Update.Key).toEqual({ pk: "CAMPAIGN#CMP1", sk: "METADATA" });
    });

    test("detach clears the content side, then the campaign back-pointer", async () => {
      mockSend.mockResolvedValueOnce({ Item: { contentId: "C1", campaignId: "CMP1" } }); // getContent
      mockSend.mockResolvedValueOnce({}); // content REMOVE campaignId
      mockSend.mockResolvedValueOnce({}); // campaign REMOVE contentId
      mockSend.mockResolvedValueOnce({ Item: { contentId: "C1" } }); // read-back

      const updated = await detachCampaign(TENANT, "C1");
      expect(updated.campaignId).toBeUndefined();

      // Content side cleared first (guarded only on existence).
      expect(input(mockSend, 1).Key).toEqual(contentKey(TENANT, "C1"));
      expect(input(mockSend, 1).UpdateExpression).toMatch(/REMOVE #campaignId/);
      // Campaign back-pointer cleared, guarded to the linked content.
      expect(input(mockSend, 2).Key).toEqual({ pk: "CAMPAIGN#CMP1", sk: "METADATA" });
      expect(input(mockSend, 2).UpdateExpression).toMatch(/REMOVE #contentId, #tenantId/);
      expect(input(mockSend, 2).ConditionExpression).toBe("#contentId = :contentId");
    });

    test("detach still succeeds for a legacy link whose campaign has no back-pointer", async () => {
      // Content created before the back-pointer existed: the campaign row's
      // guarded clear fails its condition, but detach must still clear the
      // content side and resolve rather than surfacing a transaction error.
      mockSend.mockResolvedValueOnce({ Item: { contentId: "C1", campaignId: "CMP1" } }); // getContent
      mockSend.mockResolvedValueOnce({}); // content REMOVE campaignId
      mockSend.mockRejectedValueOnce({ name: "ConditionalCheckFailedException" }); // campaign clear no-op
      mockSend.mockResolvedValueOnce({ Item: { contentId: "C1" } }); // read-back

      const updated = await detachCampaign(TENANT, "C1");
      expect(updated.campaignId).toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(4);
    });

    test("detach is a no-op for an unsponsored piece", async () => {
      mockSend.mockResolvedValueOnce({ Item: { contentId: "C1" } }); // getContent, no campaignId
      await detachCampaign(TENANT, "C1");
      // Only the single getContent read — nothing to clear.
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe("getContent / findContent", () => {
    test("getContent returns the item", async () => {
      mockSend.mockResolvedValue({ Item: { contentId: "C1", title: "Hi" } });
      expect(await getContent(TENANT, "C1")).toEqual({ contentId: "C1", title: "Hi" });
      expect(input(mockSend).Key).toEqual(contentKey(TENANT, "C1"));
    });

    test("getContent throws NotFoundError when missing", async () => {
      mockSend.mockResolvedValue({});
      await expect(getContent(TENANT, "C1")).rejects.toThrow(/Content C1 not found/);
    });

    test("findContent returns null when missing (does not throw)", async () => {
      mockSend.mockResolvedValue({});
      expect(await findContent(TENANT, "C1")).toBeNull();
    });
  });

  describe("listContentByTenant", () => {
    test("queries the per-tenant content GSI partition newest-first", async () => {
      mockSend.mockResolvedValue({ Items: [{ contentId: "C2" }], LastEvaluatedKey: { pk: "x" } });
      const result = await listContentByTenant(TENANT, { limit: 10 });

      const i = input(mockSend);
      expect(i.IndexName).toBe("GSI1");
      expect(i.ExpressionAttributeValues[":pk"]).toBe(`TENANT#${TENANT}#CONTENT`);
      expect(i.ScanIndexForward).toBe(false);
      expect(i.Limit).toBe(10);
      expect(i.FilterExpression).toBeUndefined();
      expect(result.items).toEqual([{ contentId: "C2" }]);
      expect(result.lastEvaluatedKey).toEqual({ pk: "x" });
    });

    test("adds a FilterExpression for type/source/status filters", async () => {
      mockSend.mockResolvedValue({ Items: [] });
      await listContentByTenant(TENANT, { type: "blog", source: "owned", status: "published" });

      const i = input(mockSend);
      expect(i.FilterExpression).toBe("#type = :type AND #source = :source AND #status = :status");
      expect(i.ExpressionAttributeNames).toEqual({ "#type": "type", "#source": "source", "#status": "status" });
      expect(i.ExpressionAttributeValues[":type"]).toBe("blog");
      expect(i.ExpressionAttributeValues[":source"]).toBe("owned");
      expect(i.ExpressionAttributeValues[":status"]).toBe("published");
    });
  });

  describe("updateContent", () => {
    test("sets provided fields, skips protected ones, bumps updatedAt", async () => {
      mockSend.mockResolvedValue({ Attributes: { contentId: "C1", title: "New" } });
      await updateContent(TENANT, "C1", { title: "New", links: { hacked: true }, tenantId: "evil", ids: {} });

      const i = input(mockSend);
      expect(i.Key).toEqual(contentKey(TENANT, "C1"));
      expect(i.ExpressionAttributeNames["#title"]).toBe("title");
      expect(i.ExpressionAttributeNames["#tenantId"]).toBeUndefined();
      expect(i.ExpressionAttributeValues[":links"]).toBeUndefined();
      expect(i.UpdateExpression).toMatch(/#updatedAt = :updatedAt/);
      expect(i.ConditionExpression).toBe("attribute_exists(sk)");
    });

    test("mirrors canonicalUrl into links.url", async () => {
      mockSend.mockResolvedValue({ Attributes: {} });
      await updateContent(TENANT, "C1", { canonicalUrl: "https://x/z" });

      const i = input(mockSend);
      expect(i.ExpressionAttributeNames["#links"]).toBe("links");
      expect(i.ExpressionAttributeNames["#url"]).toBe("url");
      expect(i.UpdateExpression).toMatch(/#links\.#url = :canonicalUrl/);
      expect(i.ExpressionAttributeValues[":canonicalUrl"]).toBe("https://x/z");
    });

    test("throws NotFoundError when the content does not exist", async () => {
      const err = new Error("conditional");
      err.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValue(err);
      await expect(updateContent(TENANT, "C1", { title: "x" })).rejects.toThrow(/Content C1 not found/);
    });
  });

  describe("deleteContent", () => {
    test("cascades the root and all child rows", async () => {
      mockSend
        .mockResolvedValueOnce({
          Items: [
            { pk: `TENANT#${TENANT}`, sk: "CONTENT#C1" },
            { pk: `TENANT#${TENANT}`, sk: "CONTENT#C1#PUBLISH#x" },
            { pk: `TENANT#${TENANT}`, sk: "CONTENT#C1#STATS#x#2026-06-22" },
            { pk: `TENANT#${TENANT}`, sk: "CONTENT#C1#VECTORINDEX" },
          ],
        })
        .mockResolvedValue({});

      const result = await deleteContent(TENANT, "C1");

      expect(result).toEqual({ deleted: 4 });
      const requests = input(mockSend, 1).RequestItems["test-booked"];
      expect(requests).toHaveLength(4);
      expect(requests[0].DeleteRequest.Key).toEqual({ pk: `TENANT#${TENANT}`, sk: "CONTENT#C1" });
    });

    test("throws NotFoundError when the content root is absent", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });
      await expect(deleteContent(TENANT, "C1")).rejects.toThrow(/Content C1 not found/);
    });

    test("batches deletes in chunks of 25", async () => {
      const items = Array.from({ length: 30 }, (_v, i) => ({
        pk: `TENANT#${TENANT}`,
        sk: i === 0 ? "CONTENT#C1" : `CONTENT#C1#STATS#x#2026-06-${String(i).padStart(2, "0")}`,
      }));
      mockSend.mockResolvedValueOnce({ Items: items }).mockResolvedValue({});

      const result = await deleteContent(TENANT, "C1");

      expect(result).toEqual({ deleted: 30 });
      // 1 query + 2 batch writes (25 + 5)
      expect(mockSend).toHaveBeenCalledTimes(3);
      expect(input(mockSend, 1).RequestItems["test-booked"]).toHaveLength(25);
      expect(input(mockSend, 2).RequestItems["test-booked"]).toHaveLength(5);
    });
  });

  describe("vector state", () => {
    test("getContentVectorState returns null when absent", async () => {
      mockSend.mockResolvedValue({});
      expect(await getContentVectorState(TENANT, "C1")).toBeNull();
      expect(input(mockSend).Key).toEqual(contentVectorStateKey(TENANT, "C1"));
    });

    test("putContentVectorState writes the ContentVectorIndex row", async () => {
      mockSend.mockResolvedValue({});
      await putContentVectorState(TENANT, "C1", { contentHash: "h1", chunkCount: 3 });

      const item = input(mockSend).Item;
      expect(item).toMatchObject({
        sk: "CONTENT#C1#VECTORINDEX",
        entity: "ContentVectorIndex",
        tenantId: TENANT,
        contentId: "C1",
        contentHash: "h1",
        chunkCount: 3,
      });
      expect(item.embeddedAt).toBeDefined();
    });
  });

  describe("child writers", () => {
    test("putPublishVariant writes a ContentPublish row", async () => {
      mockSend.mockResolvedValue({});
      const item = await putPublishVariant(TENANT, "C1", "x", { url: "https://x/p" });
      expect(item).toMatchObject({
        sk: "CONTENT#C1#PUBLISH#x",
        entity: "ContentPublish",
        platform: "x",
        url: "https://x/p",
      });
      expect(input(mockSend).Item.sk).toBe("CONTENT#C1#PUBLISH#x");
    });

    test("listPublishVariants queries the PUBLISH prefix", async () => {
      mockSend.mockResolvedValue({ Items: [{ platform: "x" }] });
      const variants = await listPublishVariants(TENANT, "C1");
      expect(variants).toEqual([{ platform: "x" }]);
      expect(input(mockSend).ExpressionAttributeValues[":prefix"]).toBe("CONTENT#C1#PUBLISH#");
    });

    test("putStatsSnapshot writes a ContentStats row", async () => {
      mockSend.mockResolvedValue({});
      const item = await putStatsSnapshot(TENANT, "C1", "x", "2026-06-22", { views: 5 });
      expect(item).toMatchObject({
        sk: "CONTENT#C1#STATS#x#2026-06-22",
        entity: "ContentStats",
        platform: "x",
        date: "2026-06-22",
        views: 5,
      });
    });

    test("listContentStats queries the STATS prefix and sorts by platform+date", async () => {
      mockSend.mockResolvedValue({
        Items: [
          { platform: "medium", date: "2026-06-02", metrics: { reads: 3 } },
          { platform: "devto", date: "2026-06-02", metrics: { views: 9 } },
          { platform: "devto", date: "2026-06-01", metrics: { views: 5 } },
        ],
      });
      const stats = await listContentStats(TENANT, "C1");
      expect(input(mockSend).ExpressionAttributeValues[":prefix"]).toBe("CONTENT#C1#STATS#");
      expect(stats.map((s) => `${s.platform}#${s.date}`)).toEqual([
        "devto#2026-06-01", "devto#2026-06-02", "medium#2026-06-02",
      ]);
    });
  });
});
