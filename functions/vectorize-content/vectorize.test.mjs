import { jest } from "@jest/globals";
import { createHash } from "node:crypto";

process.env.TABLE_NAME = "test-booked";
process.env.VECTOR_BUCKET_NAME = "test-bucket";
process.env.CONTENT_VECTOR_INDEX_NAME = "content-vectors";

// Mock the collaborators; chunking runs for real so chunk counts are realistic.
jest.unstable_mockModule("../../api/domain/content.mjs", () => ({
  getContentVectorState: jest.fn(),
  putContentVectorState: jest.fn(),
}));
jest.unstable_mockModule("../../api/services/embeddings.mjs", () => ({
  embedText: jest.fn(),
  EMBEDDING_DIMENSIONS: 1024,
}));
jest.unstable_mockModule("../../api/services/content-vectors.mjs", () => ({
  putContentChunks: jest.fn(),
  deleteContentChunkRange: jest.fn(),
}));

const { getContentVectorState, putContentVectorState } = await import("../../api/domain/content.mjs");
const { embedText } = await import("../../api/services/embeddings.mjs");
const { putContentChunks, deleteContentChunkRange } = await import("../../api/services/content-vectors.mjs");
const { vectorizeContent, removeContentVectors, buildVectorText } = await import("./vectorize.mjs");

const hashOf = (text) => createHash("sha256").update(text).digest("hex");

const content = {
  tenantId: "T1",
  contentId: "C1",
  type: "blog",
  title: "My Post",
  description: "A description",
  slug: "my-post",
  contentMarkdown: "Some body content.",
};

beforeEach(() => {
  jest.clearAllMocks();
  embedText.mockResolvedValue([0.1, 0.2, 0.3]);
  putContentChunks.mockResolvedValue();
  deleteContentChunkRange.mockResolvedValue();
  putContentVectorState.mockResolvedValue();
});

describe("vectorizeContent", () => {
  test("embeds and stores chunks for new content", async () => {
    getContentVectorState.mockResolvedValue(null);

    const result = await vectorizeContent(content);

    expect(result.skipped).toBe(false);
    expect(result.chunkCount).toBeGreaterThanOrEqual(1);
    expect(embedText).toHaveBeenCalled();
    expect(putContentChunks).toHaveBeenCalledTimes(1);
    const putArg = putContentChunks.mock.calls[0][0];
    expect(putArg.contentId).toBe("C1");
    expect(putArg.slug).toBe("my-post");
    expect(putArg.type).toBe("blog");
    expect(putArg.chunks[0]).toHaveProperty("embedding");
    expect(deleteContentChunkRange).not.toHaveBeenCalled();
    expect(putContentVectorState).toHaveBeenCalledWith("T1", "C1", expect.objectContaining({
      chunkCount: result.chunkCount,
    }));
  });

  test("skips when the content hash is unchanged", async () => {
    const unchangedHash = hashOf(buildVectorText(content));
    getContentVectorState.mockResolvedValue({ contentHash: unchangedHash, chunkCount: 1 });

    const result = await vectorizeContent(content);

    expect(result).toEqual({ skipped: true, reason: "unchanged" });
    expect(embedText).not.toHaveBeenCalled();
    expect(putContentChunks).not.toHaveBeenCalled();
    expect(putContentVectorState).not.toHaveBeenCalled();
  });

  test("re-embeds and trims stale tail chunks on a shrinking edit", async () => {
    // Old state had 10 chunks; the new (small) piece yields fewer.
    getContentVectorState.mockResolvedValue({ contentHash: "stale", chunkCount: 10 });

    const result = await vectorizeContent(content);

    expect(result.skipped).toBe(false);
    expect(deleteContentChunkRange).toHaveBeenCalledWith("C1", result.chunkCount, 10);
  });

  test("skips content with no embeddable text", async () => {
    getContentVectorState.mockResolvedValue(null);
    const result = await vectorizeContent({ tenantId: "T1", contentId: "C2", title: "  " });
    expect(result).toEqual({ skipped: true, reason: "empty" });
    expect(embedText).not.toHaveBeenCalled();
  });
});

describe("removeContentVectors", () => {
  test("deletes the recorded number of chunks", async () => {
    getContentVectorState.mockResolvedValue({ chunkCount: 4 });
    await removeContentVectors("T1", "C1");
    expect(deleteContentChunkRange).toHaveBeenCalledWith("C1", 0, 4);
  });

  test("falls back to the max range when state is missing", async () => {
    getContentVectorState.mockResolvedValue(null);
    await removeContentVectors("T1", "C1");
    expect(deleteContentChunkRange).toHaveBeenCalledWith("C1", 0, 512);
  });
});
