import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const {
  createBlog,
  getBlog,
  findBlog,
  listBlogsByTenant,
  listBlogsForCampaign,
  updateBlog,
  deleteBlog,
  blogKey,
  crosspostCopyKey,
  crosspostRunKey,
  viewSnapshotKey,
  campaignRefKey,
  startCrosspostRun,
  recordCrosspostResult,
  completeCrosspostRun,
  getCrosspostStatus,
} = await import("../domain/blog.mjs");

// Pulls the typed command (TransactWrite / BatchWrite / etc.) out of a
// mockSend call by its 1-based index.
function callInput(mockSend, i) {
  return mockSend.mock.calls[i][0].input;
}

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

  describe("campaign linkage", () => {
    describe("createBlog with campaignId", () => {
      test("transactionally writes the blog and the campaign ref", async () => {
        mockSend
          .mockResolvedValueOnce({ Item: { campaignId: "camp-1" } }) // findCampaign
          .mockResolvedValueOnce({}); // transact write

        const item = await createBlog(TENANT, {
          title: "Hi",
          slug: "hi",
          canonicalUrl: "https://x/blog/hi",
          contentMarkdown: "b",
          campaignId: "camp-1",
        });

        const tx = callInput(mockSend, 1).TransactItems;
        expect(tx).toHaveLength(2);
        expect(tx[0].Put.Item.entity).toBe("Blog");
        expect(tx[0].Put.ConditionExpression).toBe("attribute_not_exists(sk)");
        expect(tx[1].Put.Item).toMatchObject({ entity: "BlogCampaignRef", campaignId: "camp-1", blogId: item.blogId });
        expect(tx[1].Put.Item.sk).toBe(`CAMPAIGNREF#camp-1#${item.blogId}`);
      });

      test("throws NotFound (and writes nothing) when the campaign is missing", async () => {
        mockSend.mockResolvedValueOnce({}); // findCampaign → null
        await expect(createBlog(TENANT, {
          title: "Hi", slug: "hi", canonicalUrl: "https://x/blog/hi", contentMarkdown: "b", campaignId: "missing",
        })).rejects.toThrow(/Campaign missing not found/);
        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    });

    describe("updateBlog campaignId changes", () => {
      test("links to a new campaign: update + put ref, after existence check", async () => {
        mockSend
          .mockResolvedValueOnce({ Item: { blogId: "B1", sk: "BLOG#B1" } }) // getBlog existing
          .mockResolvedValueOnce({ Item: { campaignId: "camp-1" } }) // findCampaign
          .mockResolvedValueOnce({}) // transact write
          .mockResolvedValueOnce({ Item: { blogId: "B1", campaignId: "camp-1" } }); // getBlog updated

        const updated = await updateBlog(TENANT, "B1", { campaignId: "camp-1" });

        const tx = callInput(mockSend, 2).TransactItems;
        expect(tx.some((i) => i.Update)).toBe(true);
        expect(tx.some((i) => i.Put?.Item?.sk === "CAMPAIGNREF#camp-1#B1")).toBe(true);
        expect(tx.some((i) => i.Delete)).toBe(false);
        expect(updated.campaignId).toBe("camp-1");
      });

      test("moves between campaigns: delete old ref + put new ref", async () => {
        mockSend
          .mockResolvedValueOnce({ Item: { blogId: "B1", sk: "BLOG#B1", campaignId: "camp-A" } })
          .mockResolvedValueOnce({ Item: { campaignId: "camp-B" } })
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ Item: { blogId: "B1", campaignId: "camp-B" } });

        await updateBlog(TENANT, "B1", { campaignId: "camp-B" });

        const tx = callInput(mockSend, 2).TransactItems;
        expect(tx.some((i) => i.Delete?.Key?.sk === "CAMPAIGNREF#camp-A#B1")).toBe(true);
        expect(tx.some((i) => i.Put?.Item?.sk === "CAMPAIGNREF#camp-B#B1")).toBe(true);
      });

      test("clears the link: delete old ref, no campaign lookup", async () => {
        mockSend
          .mockResolvedValueOnce({ Item: { blogId: "B1", sk: "BLOG#B1", campaignId: "camp-A" } }) // getBlog
          .mockResolvedValueOnce({}) // transact write
          .mockResolvedValueOnce({ Item: { blogId: "B1" } }); // getBlog updated

        await updateBlog(TENANT, "B1", { campaignId: null });

        const tx = callInput(mockSend, 1).TransactItems; // no findCampaign call
        expect(tx.some((i) => i.Delete?.Key?.sk === "CAMPAIGNREF#camp-A#B1")).toBe(true);
        expect(tx.some((i) => i.Put)).toBe(false);
      });
    });

    test("deleteBlog also removes the campaign ref row", async () => {
      mockSend
        .mockResolvedValueOnce({ Items: [{ pk: `TENANT#${TENANT}`, sk: "BLOG#B1", campaignId: "camp-A" }] })
        .mockResolvedValue({});

      const result = await deleteBlog(TENANT, "B1");

      expect(result).toEqual({ deleted: 2 }); // root + ref
      const keys = callInput(mockSend, 1).RequestItems["test-booked"].map((r) => r.DeleteRequest.Key);
      expect(keys).toContainEqual({ pk: `TENANT#${TENANT}`, sk: "CAMPAIGNREF#camp-A#B1" });
    });

    describe("listBlogsForCampaign", () => {
      test("queries refs, batch-gets the blogs, sorts newest first", async () => {
        mockSend
          .mockResolvedValueOnce({ Items: [{ blogId: "B1" }, { blogId: "B2" }] })
          .mockResolvedValueOnce({ Responses: { "test-booked": [
            { blogId: "B1", createdAt: "2026-01-01T00:00:00.000Z" },
            { blogId: "B2", createdAt: "2026-02-01T00:00:00.000Z" },
          ] } });

        const blogs = await listBlogsForCampaign(TENANT, "camp-A");

        expect(callInput(mockSend, 0).ExpressionAttributeValues[":prefix"]).toBe("CAMPAIGNREF#camp-A#");
        expect(blogs.map((b) => b.blogId)).toEqual(["B2", "B1"]);
      });

      test("returns [] without a batch-get when there are no refs", async () => {
        mockSend.mockResolvedValueOnce({ Items: [] });
        expect(await listBlogsForCampaign(TENANT, "camp-A")).toEqual([]);
        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("cross-post writers", () => {
    test("startCrosspostRun seeds the run + pending/scheduled copies", async () => {
      mockSend.mockResolvedValue({});
      await startCrosspostRun(TENANT, "B1", {
        runId: "R1",
        platforms: [{ platform: "dev", delaySeconds: 0 }, { platform: "medium", delaySeconds: 259200 }],
      });

      const puts = callInput(mockSend, 0).RequestItems["test-booked"].map((r) => r.PutRequest.Item);
      const run = puts.find((i) => i.entity === "BlogCrosspostRun");
      expect(run).toMatchObject({ sk: "BLOG#B1#RUN#R1", status: "in progress", platforms: ["dev", "medium"] });
      const dev = puts.find((i) => i.sk === "BLOG#B1#CROSSPOST#dev");
      const medium = puts.find((i) => i.sk === "BLOG#B1#CROSSPOST#medium");
      expect(dev.status).toBe("pending");
      expect(medium.status).toBe("scheduled");
      expect(medium.scheduledFor).toBeDefined();
    });

    test("recordCrosspostResult success updates the copy and mirrors onto the blog root", async () => {
      mockSend.mockResolvedValue({});
      await recordCrosspostResult(TENANT, "B1", "dev", { runId: "R1", status: "succeeded", url: "https://dev/x", id: 99 });

      const tx = callInput(mockSend, 0).TransactItems;
      const copy = tx.find((i) => i.Update.Key.sk === "BLOG#B1#CROSSPOST#dev").Update;
      expect(copy.ExpressionAttributeValues[":status"]).toBe("succeeded");
      expect(copy.ExpressionAttributeValues[":url"]).toBe("https://dev/x");
      expect(copy.UpdateExpression).toMatch(/REMOVE #error/);

      const root = tx.find((i) => i.Update.Key.sk === "BLOG#B1").Update;
      expect(root.ExpressionAttributeNames["#p"]).toBe("dev");
      expect(root.UpdateExpression).toMatch(/#links\.#p = :url/);
      expect(root.UpdateExpression).toMatch(/#ids\.#p = :id/);
    });

    test("recordCrosspostResult failure marks the copy failed (no root write)", async () => {
      mockSend.mockResolvedValue({});
      await recordCrosspostResult(TENANT, "B1", "medium", { runId: "R1", status: "failed", error: "401" });

      const input = callInput(mockSend, 0);
      expect(input.Key.sk).toBe("BLOG#B1#CROSSPOST#medium");
      expect(input.ExpressionAttributeValues[":status"]).toBe("failed");
      expect(input.ExpressionAttributeValues[":error"]).toBe("401");
      expect(input.TransactItems).toBeUndefined();
    });

    test("completeCrosspostRun sets the run status + completedAt", async () => {
      mockSend.mockResolvedValue({});
      await completeCrosspostRun(TENANT, "B1", "R1", "succeeded");

      const input = callInput(mockSend, 0);
      expect(input.Key.sk).toBe("BLOG#B1#RUN#R1");
      expect(input.ExpressionAttributeValues[":status"]).toBe("succeeded");
      expect(input.ExpressionAttributeValues[":now"]).toBeDefined();
    });

    test("getCrosspostStatus returns the copies + latest run", async () => {
      mockSend
        .mockResolvedValueOnce({ Items: [{ platform: "dev", status: "succeeded" }] }) // copies query
        .mockResolvedValueOnce({ Items: [{ runId: "R1", status: "succeeded" }] }); // latest run query

      const status = await getCrosspostStatus(TENANT, "B1");

      expect(callInput(mockSend, 0).ExpressionAttributeValues[":prefix"]).toBe("BLOG#B1#CROSSPOST#");
      const runInput = callInput(mockSend, 1);
      expect(runInput.ExpressionAttributeValues[":prefix"]).toBe("BLOG#B1#RUN#");
      expect(runInput.ScanIndexForward).toBe(false);
      expect(runInput.Limit).toBe(1);
      expect(status).toEqual({ copies: [{ platform: "dev", status: "succeeded" }], run: { runId: "R1", status: "succeeded" } });
    });
  });
});
