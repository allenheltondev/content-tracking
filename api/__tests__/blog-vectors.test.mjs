import { jest } from "@jest/globals";

process.env.VECTOR_BUCKET_NAME = "test-vectors";
process.env.VECTOR_INDEX_NAME = "blog-vectors";

const { S3VectorsClient } = await import("@aws-sdk/client-s3vectors");
const { queryBlogChunks, putBlogChunks, deleteBlogChunkRange, vectorKey } = await import("../services/blog-vectors.mjs");

describe("services/blog-vectors", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    S3VectorsClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  describe("vectorKey", () => {
    test("is `${blogId}#${chunkIndex}`", () => {
      expect(vectorKey("B1", 0)).toBe("B1#0");
      expect(vectorKey("B1", 12)).toBe("B1#12");
    });
  });

  describe("queryBlogChunks", () => {
    test("queries the index tenant-scoped and maps metadata out", async () => {
      mockSend.mockResolvedValueOnce({
        vectors: [
          { key: "B1#0", distance: 0.12, metadata: { blogId: "B1", title: "T1", slug: "t1", chunkIndex: 0, text: "body one" } },
        ],
      });

      const out = await queryBlogChunks({ tenantId: "T1", queryEmbedding: [0.1, 0.2], topK: 5 });

      const command = mockSend.mock.calls[0][0];
      expect(command.input.vectorBucketName).toBe("test-vectors");
      expect(command.input.indexName).toBe("blog-vectors");
      expect(command.input.topK).toBe(5);
      expect(command.input.queryVector).toEqual({ float32: [0.1, 0.2] });
      expect(command.input.filter).toEqual({ tenantId: "T1" });
      expect(command.input.returnMetadata).toBe(true);
      expect(command.input.returnDistance).toBe(true);

      expect(out).toEqual([
        { key: "B1#0", distance: 0.12, blogId: "B1", title: "T1", slug: "t1", chunkIndex: 0, text: "body one" },
      ]);
    });

    test("adds blogId to the filter when narrowing to one post", async () => {
      mockSend.mockResolvedValueOnce({ vectors: [] });
      await queryBlogChunks({ tenantId: "T1", queryEmbedding: [0.1], blogId: "B9" });
      expect(mockSend.mock.calls[0][0].input.filter).toEqual({ tenantId: "T1", blogId: "B9" });
    });

    test("returns [] when the index has no matches", async () => {
      mockSend.mockResolvedValueOnce({});
      const out = await queryBlogChunks({ tenantId: "T1", queryEmbedding: [0.1] });
      expect(out).toEqual([]);
    });

    test("requires a tenantId", async () => {
      await expect(queryBlogChunks({ queryEmbedding: [0.1] })).rejects.toThrow(/tenantId/);
    });
  });

  describe("putBlogChunks", () => {
    test("upserts vectors with key, embedding, and filterable metadata", async () => {
      mockSend.mockResolvedValue({});
      await putBlogChunks({
        tenantId: "T1",
        blogId: "B1",
        slug: "t1",
        title: "T1",
        chunks: [{ index: 0, text: "chunk a", embedding: [0.1, 0.2] }],
      });

      const command = mockSend.mock.calls[0][0];
      const v = command.input.vectors[0];
      expect(v.key).toBe("B1#0");
      expect(v.data).toEqual({ float32: [0.1, 0.2] });
      expect(v.metadata).toMatchObject({ tenantId: "T1", blogId: "B1", chunkIndex: 0, text: "chunk a" });
    });

    test("is a no-op for an empty chunk list", async () => {
      await putBlogChunks({ tenantId: "T1", blogId: "B1", chunks: [] });
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("deleteBlogChunkRange", () => {
    test("deletes the computed key range", async () => {
      mockSend.mockResolvedValue({});
      await deleteBlogChunkRange("B1", 1, 4);
      const command = mockSend.mock.calls[0][0];
      expect(command.input.keys).toEqual(["B1#1", "B1#2", "B1#3"]);
    });

    test("is a no-op when the range is empty", async () => {
      await deleteBlogChunkRange("B1", 3, 3);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
