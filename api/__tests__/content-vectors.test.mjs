import { jest } from "@jest/globals";

process.env.VECTOR_BUCKET_NAME = "test-vectors";
process.env.CONTENT_VECTOR_INDEX_NAME = "content-vectors";

const { S3VectorsClient } = await import("@aws-sdk/client-s3vectors");
const { queryContentChunks, putContentChunks, deleteContentChunkRange, contentVectorKey } = await import("../services/content-vectors.mjs");

describe("services/content-vectors", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    S3VectorsClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  describe("contentVectorKey", () => {
    test("is `${contentId}#${chunkIndex}`", () => {
      expect(contentVectorKey("C1", 0)).toBe("C1#0");
      expect(contentVectorKey("C1", 12)).toBe("C1#12");
    });
  });

  describe("queryContentChunks", () => {
    test("queries the index tenant-scoped and maps metadata out", async () => {
      mockSend.mockResolvedValueOnce({
        vectors: [
          { key: "C1#0", distance: 0.12, metadata: { contentId: "C1", type: "blog", title: "T1", slug: "t1", chunkIndex: 0, text: "body one" } },
        ],
      });

      const out = await queryContentChunks({ tenantId: "T1", queryEmbedding: [0.1, 0.2], topK: 5 });

      const command = mockSend.mock.calls[0][0];
      expect(command.input.vectorBucketName).toBe("test-vectors");
      expect(command.input.indexName).toBe("content-vectors");
      expect(command.input.topK).toBe(5);
      expect(command.input.queryVector).toEqual({ float32: [0.1, 0.2] });
      expect(command.input.filter).toEqual({ tenantId: "T1" });
      expect(command.input.returnMetadata).toBe(true);
      expect(command.input.returnDistance).toBe(true);

      expect(out).toEqual([
        { key: "C1#0", distance: 0.12, contentId: "C1", type: "blog", title: "T1", slug: "t1", chunkIndex: 0, text: "body one" },
      ]);
    });

    test("adds contentId to the filter when narrowing to one piece", async () => {
      mockSend.mockResolvedValueOnce({ vectors: [] });
      await queryContentChunks({ tenantId: "T1", queryEmbedding: [0.1], contentId: "C9" });
      expect(mockSend.mock.calls[0][0].input.filter).toEqual({ tenantId: "T1", contentId: "C9" });
    });

    test("adds type to the filter when narrowing to one type", async () => {
      mockSend.mockResolvedValueOnce({ vectors: [] });
      await queryContentChunks({ tenantId: "T1", queryEmbedding: [0.1], type: "blog" });
      expect(mockSend.mock.calls[0][0].input.filter).toEqual({ tenantId: "T1", type: "blog" });
    });

    test("returns [] when the index has no matches", async () => {
      mockSend.mockResolvedValueOnce({});
      const out = await queryContentChunks({ tenantId: "T1", queryEmbedding: [0.1] });
      expect(out).toEqual([]);
    });

    test("requires a tenantId", async () => {
      await expect(queryContentChunks({ queryEmbedding: [0.1] })).rejects.toThrow(/tenantId/);
    });
  });

  describe("putContentChunks", () => {
    test("upserts vectors with key, embedding, and filterable metadata", async () => {
      mockSend.mockResolvedValue({});
      await putContentChunks({
        tenantId: "T1",
        contentId: "C1",
        type: "blog",
        title: "T1",
        slug: "t1",
        chunks: [{ index: 0, text: "chunk a", embedding: [0.1, 0.2] }],
      });

      const command = mockSend.mock.calls[0][0];
      const v = command.input.vectors[0];
      expect(v.key).toBe("C1#0");
      expect(v.data).toEqual({ float32: [0.1, 0.2] });
      expect(v.metadata).toMatchObject({ tenantId: "T1", contentId: "C1", type: "blog", chunkIndex: 0, text: "chunk a" });
    });

    test("is a no-op for an empty chunk list", async () => {
      await putContentChunks({ tenantId: "T1", contentId: "C1", chunks: [] });
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("deleteContentChunkRange", () => {
    test("deletes the computed key range", async () => {
      mockSend.mockResolvedValue({});
      await deleteContentChunkRange("C1", 1, 4);
      const command = mockSend.mock.calls[0][0];
      expect(command.input.keys).toEqual(["C1#1", "C1#2", "C1#3"]);
    });

    test("is a no-op when the range is empty", async () => {
      await deleteContentChunkRange("C1", 3, 3);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
