import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const {
  createBlog,
  getBlog,
  findBlog,
  listBlogsByTenant,
  updateBlog,
  deleteBlog,
  blogKey,
  crosspostCopyKey,
  crosspostRunKey,
  viewSnapshotKey,
  campaignRefKey,
} = await import("../domain/blog.mjs");

const TENANT = "tenant-sub-123";

describe("domain/blog", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  describe("key helpers", () => {
    test("scope every key under the tenant partition", () => {
      const pk = `TENANT#${TENANT}`;
      expect(blogKey(TENANT, "B1")).toEqual({ pk, sk: "BLOG#B1" });
      expect(crosspostCopyKey(TENANT, "B1", "dev")).toEqual({ pk, sk: "BLOG#B1#CROSSPOST#dev" });
      expect(crosspostRunKey(TENANT, "B1", "R1")).toEqual({ pk, sk: "BLOG#B1#RUN#R1" });
      expect(viewSnapshotKey(TENANT, "B1", "2026-06-22")).toEqual({ pk, sk: "BLOG#B1#VIEWCOUNT#2026-06-22" });
      expect(campaignRefKey(TENANT, "C1", "B1")).toEqual({ pk, sk: "CAMPAIGNREF#C1#B1" });
    });
  });

  describe("createBlog", () => {
    test("writes a tenant-scoped Blog root with GSI1 keys and seeded links.url", async () => {
      mockSend.mockResolvedValue({});
      const item = await createBlog(TENANT, {
        title: "Hello",
        slug: "hello",
        canonicalUrl: "https://readysetcloud.io/blog/hello",
        contentMarkdown: "# hi",
      });

      expect(item.blogId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(item.pk).toBe(`TENANT#${TENANT}`);
      expect(item.sk).toBe(`BLOG#${item.blogId}`);
      expect(item.entity).toBe("Blog");
      expect(item.tenantId).toBe(TENANT);
      expect(item.gsi1pk).toBe(`TENANT#${TENANT}#BLOG`);
      expect(item.gsi1sk).toBe(`${item.createdAt}#${item.blogId}`);
      expect(item.links).toEqual({ url: "https://readysetcloud.io/blog/hello" });
      expect(item.ids).toEqual({});

      const call = mockSend.mock.calls[0][0];
      expect(call.input.ConditionExpression).toBe("attribute_not_exists(sk)");
    });

    test("structural fields win over client-supplied overrides", async () => {
      mockSend.mockResolvedValue({});
      const item = await createBlog(TENANT, {
        title: "x",
        canonicalUrl: "https://x/blog/y",
        tenantId: "evil-tenant",
        entity: "NotABlog",
        pk: "HACK",
      });
      expect(item.tenantId).toBe(TENANT);
      expect(item.entity).toBe("Blog");
      expect(item.pk).toBe(`TENANT#${TENANT}`);
    });
  });

  describe("getBlog / findBlog", () => {
    test("getBlog returns the item", async () => {
      mockSend.mockResolvedValue({ Item: { blogId: "B1", title: "Hi" } });
      expect(await getBlog(TENANT, "B1")).toEqual({ blogId: "B1", title: "Hi" });
      expect(mockSend.mock.calls[0][0].input.Key).toEqual(blogKey(TENANT, "B1"));
    });

    test("getBlog throws NotFoundError when missing", async () => {
      mockSend.mockResolvedValue({});
      await expect(getBlog(TENANT, "B1")).rejects.toThrow(/Blog B1 not found/);
    });

    test("findBlog returns null when missing (does not throw)", async () => {
      mockSend.mockResolvedValue({});
      expect(await findBlog(TENANT, "B1")).toBeNull();
    });
  });

  describe("listBlogsByTenant", () => {
    test("queries the per-tenant blog GSI partition newest-first", async () => {
      mockSend.mockResolvedValue({ Items: [{ blogId: "B2" }], LastEvaluatedKey: { pk: "x" } });
      const result = await listBlogsByTenant(TENANT, { limit: 10 });

      const input = mockSend.mock.calls[0][0].input;
      expect(input.IndexName).toBe("GSI1");
      expect(input.ExpressionAttributeValues[":pk"]).toBe(`TENANT#${TENANT}#BLOG`);
      expect(input.ScanIndexForward).toBe(false);
      expect(input.Limit).toBe(10);
      expect(result.items).toEqual([{ blogId: "B2" }]);
      expect(result.lastEvaluatedKey).toEqual({ pk: "x" });
    });
  });

  describe("updateBlog", () => {
    test("sets provided fields, skips protected ones, bumps updatedAt", async () => {
      mockSend.mockResolvedValue({ Attributes: { blogId: "B1", title: "New" } });
      await updateBlog(TENANT, "B1", { title: "New", links: { hacked: true }, tenantId: "evil", ids: {} });

      const input = mockSend.mock.calls[0][0].input;
      expect(input.Key).toEqual(blogKey(TENANT, "B1"));
      expect(input.ExpressionAttributeNames["#title"]).toBe("title");
      expect(input.ExpressionAttributeNames["#tenantId"]).toBeUndefined();
      // links is protected unless driven by canonicalUrl; not present here.
      expect(input.ExpressionAttributeValues[":links"]).toBeUndefined();
      expect(input.UpdateExpression).toMatch(/#updatedAt = :updatedAt/);
      expect(input.ConditionExpression).toBe("attribute_exists(sk)");
    });

    test("mirrors canonicalUrl into links.url", async () => {
      mockSend.mockResolvedValue({ Attributes: {} });
      await updateBlog(TENANT, "B1", { canonicalUrl: "https://x/blog/z" });

      const input = mockSend.mock.calls[0][0].input;
      expect(input.ExpressionAttributeNames["#links"]).toBe("links");
      expect(input.ExpressionAttributeNames["#url"]).toBe("url");
      expect(input.UpdateExpression).toMatch(/#links\.#url = :canonicalUrl/);
      expect(input.ExpressionAttributeValues[":canonicalUrl"]).toBe("https://x/blog/z");
    });

    test("throws NotFoundError when the blog does not exist", async () => {
      const err = new Error("conditional");
      err.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValue(err);
      await expect(updateBlog(TENANT, "B1", { title: "x" })).rejects.toThrow(/Blog B1 not found/);
    });
  });

  describe("deleteBlog", () => {
    test("cascades the root and all child rows", async () => {
      mockSend
        .mockResolvedValueOnce({
          Items: [
            { pk: `TENANT#${TENANT}`, sk: "BLOG#B1" },
            { pk: `TENANT#${TENANT}`, sk: "BLOG#B1#CROSSPOST#dev" },
            { pk: `TENANT#${TENANT}`, sk: "BLOG#B1#VIEWCOUNT#2026-06-22" },
          ],
        })
        .mockResolvedValue({});

      const result = await deleteBlog(TENANT, "B1");

      expect(result).toEqual({ deleted: 3 });
      const batchInput = mockSend.mock.calls[1][0].input;
      const requests = batchInput.RequestItems["test-booked"];
      expect(requests).toHaveLength(3);
      expect(requests[0].DeleteRequest.Key).toEqual({ pk: `TENANT#${TENANT}`, sk: "BLOG#B1" });
    });

    test("throws NotFoundError when the blog root is absent", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });
      await expect(deleteBlog(TENANT, "B1")).rejects.toThrow(/Blog B1 not found/);
    });

    test("batches deletes in chunks of 25", async () => {
      const items = Array.from({ length: 30 }, (_v, i) => ({
        pk: `TENANT#${TENANT}`,
        sk: i === 0 ? "BLOG#B1" : `BLOG#B1#VIEWCOUNT#2026-06-${String(i).padStart(2, "0")}`,
      }));
      mockSend.mockResolvedValueOnce({ Items: items }).mockResolvedValue({});

      const result = await deleteBlog(TENANT, "B1");

      expect(result).toEqual({ deleted: 30 });
      // 1 query + 2 batch writes (25 + 5)
      expect(mockSend).toHaveBeenCalledTimes(3);
      expect(mockSend.mock.calls[1][0].input.RequestItems["test-booked"]).toHaveLength(25);
      expect(mockSend.mock.calls[2][0].input.RequestItems["test-booked"]).toHaveLength(5);
    });
  });
});
