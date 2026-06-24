import { jest } from "@jest/globals";
import { createHash } from "node:crypto";

process.env.TABLE_NAME = "test-booked";
process.env.VECTOR_BUCKET_NAME = "test-bucket";
process.env.VECTOR_INDEX_NAME = "blog-vectors";

// Mock the collaborators; chunking runs for real so chunk counts are realistic.
jest.unstable_mockModule("../../api/domain/blog.mjs", () => ({
  getVectorState: jest.fn(),
  putVectorState: jest.fn(),
}));
jest.unstable_mockModule("../../api/services/embeddings.mjs", () => ({
  embedText: jest.fn(),
  EMBEDDING_DIMENSIONS: 1024,
}));
jest.unstable_mockModule("../../api/services/blog-vectors.mjs", () => ({
  putBlogChunks: jest.fn(),
  deleteBlogChunkRange: jest.fn(),
}));

const { getVectorState, putVectorState } = await import("../../api/domain/blog.mjs");
const { embedText } = await import("../../api/services/embeddings.mjs");
const { putBlogChunks, deleteBlogChunkRange } = await import("../../api/services/blog-vectors.mjs");
const { vectorizeBlog, removeBlogVectors, buildVectorText } = await import("./vectorize.mjs");

const hashOf = (text) => createHash("sha256").update(text).digest("hex");

const blog = {
  tenantId: "T1",
  blogId: "B1",
  title: "My Post",
  description: "A description",
  slug: "my-post",
  contentMarkdown: "Some body content.",
};

beforeEach(() => {
  jest.clearAllMocks();
  embedText.mockResolvedValue([0.1, 0.2, 0.3]);
  putBlogChunks.mockResolvedValue();
  deleteBlogChunkRange.mockResolvedValue();
  putVectorState.mockResolvedValue();
});

describe("vectorizeBlog", () => {
  test("embeds and stores chunks for a new blog", async () => {
    getVectorState.mockResolvedValue(null);

    const result = await vectorizeBlog(blog);

    expect(result.skipped).toBe(false);
    expect(result.chunkCount).toBeGreaterThanOrEqual(1);
    expect(embedText).toHaveBeenCalled();
    expect(putBlogChunks).toHaveBeenCalledTimes(1);
    const putArg = putBlogChunks.mock.calls[0][0];
    expect(putArg.blogId).toBe("B1");
    expect(putArg.slug).toBe("my-post");
    expect(putArg.chunks[0]).toHaveProperty("embedding");
    expect(deleteBlogChunkRange).not.toHaveBeenCalled();
    expect(putVectorState).toHaveBeenCalledWith("T1", "B1", expect.objectContaining({
      chunkCount: result.chunkCount,
    }));
  });

  test("skips when the content hash is unchanged", async () => {
    const unchangedHash = hashOf(buildVectorText(blog));
    getVectorState.mockResolvedValue({ contentHash: unchangedHash, chunkCount: 1 });

    const result = await vectorizeBlog(blog);

    expect(result).toEqual({ skipped: true, reason: "unchanged" });
    expect(embedText).not.toHaveBeenCalled();
    expect(putBlogChunks).not.toHaveBeenCalled();
    expect(putVectorState).not.toHaveBeenCalled();
  });

  test("re-embeds and trims stale tail chunks on a shrinking edit", async () => {
    // Old state had 10 chunks; the new (small) post yields fewer.
    getVectorState.mockResolvedValue({ contentHash: "stale", chunkCount: 10 });

    const result = await vectorizeBlog(blog);

    expect(result.skipped).toBe(false);
    expect(deleteBlogChunkRange).toHaveBeenCalledWith("B1", result.chunkCount, 10);
  });

  test("skips blogs with no embeddable text", async () => {
    getVectorState.mockResolvedValue(null);
    const result = await vectorizeBlog({ tenantId: "T1", blogId: "B2", title: "  " });
    expect(result).toEqual({ skipped: true, reason: "empty" });
    expect(embedText).not.toHaveBeenCalled();
  });
});

describe("removeBlogVectors", () => {
  test("deletes the recorded number of chunks", async () => {
    getVectorState.mockResolvedValue({ chunkCount: 4 });
    await removeBlogVectors("T1", "B1");
    expect(deleteBlogChunkRange).toHaveBeenCalledWith("B1", 0, 4);
  });

  test("falls back to the max range when state is missing", async () => {
    getVectorState.mockResolvedValue(null);
    await removeBlogVectors("T1", "B1");
    expect(deleteBlogChunkRange).toHaveBeenCalledWith("B1", 0, 512);
  });
});
