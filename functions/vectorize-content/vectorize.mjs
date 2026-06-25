import { createHash } from "node:crypto";
import { getContentVectorState, putContentVectorState } from "../../api/domain/content.mjs";
import { chunkMarkdown } from "../../api/services/chunking.mjs";
import { embedText } from "../../api/services/embeddings.mjs";
import { putContentChunks, deleteContentChunkRange } from "../../api/services/content-vectors.mjs";
import { logger } from "../../api/services/logger.mjs";

// Core content→vectors logic, shared by the stream handler (index.mjs) and any
// one-shot backfill script. Kept separate from the handler so both entry points
// run the exact same path.

// Bounded concurrency for the per-chunk embedding calls. Titan is fast but
// rate-limited; a handful in flight keeps a long piece quick without tripping
// throttling.
const EMBED_CONCURRENCY = 4;

// When content is deleted we may no longer be able to read its chunk count
// (the state row is removed by the same cascade). Delete this many chunk keys
// defensively — DeleteVectors ignores keys that don't exist, and the chunker
// caps at 512 chunks, so this fully covers any piece of content.
const MAX_CHUNKS_FALLBACK = 512;

// Builds the text we actually embed: title and description lead so their terms
// land in the first chunk(s), then the full body. Mirrors what a reader sees.
export function buildVectorText(content) {
  return [content.title, content.description, content.contentMarkdown]
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .join("\n\n");
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

// (Re)vectorizes one content root item. Skips the work when the content text is
// unchanged since the last run (so cross-post-driven root updates don't
// re-embed). Returns a small result object for logging/testing.
export async function vectorizeContent(content) {
  const { tenantId, contentId } = content;
  if (!tenantId || !contentId) {
    logger.warn("Skipping vectorization: missing tenantId/contentId", { tenantId, contentId });
    return { skipped: true, reason: "missing-keys" };
  }

  const text = buildVectorText(content);
  if (text.trim().length === 0) {
    logger.warn("Skipping vectorization: no text to embed", { contentId });
    return { skipped: true, reason: "empty" };
  }

  const contentHash = hashText(text);
  const state = await getContentVectorState(tenantId, contentId);
  if (state?.contentHash === contentHash) {
    logger.info("Skipping vectorization: content unchanged", { contentId });
    return { skipped: true, reason: "unchanged" };
  }

  const chunks = chunkMarkdown(text);
  if (chunks.length === MAX_CHUNKS_FALLBACK) {
    // The chunker stops at MAX_CHUNKS_FALLBACK; if we hit it exactly the piece
    // may have been truncated, so surface it rather than silently dropping.
    logger.warn("Content hit the chunk cap; trailing content may be unindexed", {
      contentId,
      chunkCap: MAX_CHUNKS_FALLBACK,
    });
  }

  const embedded = await mapWithConcurrency(chunks, EMBED_CONCURRENCY, async (chunk) => ({
    ...chunk,
    embedding: await embedText(chunk.text),
  }));

  await putContentChunks({
    tenantId,
    contentId,
    type: content.type,
    title: content.title,
    slug: content.slug,
    chunks: embedded,
  });

  // A shrinking edit leaves stale tail chunks behind; remove the old surplus.
  const oldCount = state?.chunkCount ?? 0;
  if (oldCount > embedded.length) {
    await deleteContentChunkRange(contentId, embedded.length, oldCount);
  }

  await putContentVectorState(tenantId, contentId, { contentHash, chunkCount: embedded.length });

  logger.info("Vectorized content", { contentId, chunkCount: embedded.length });
  return { skipped: false, chunkCount: embedded.length };
}

// Removes every vector for a piece of content. Uses the recorded chunk count
// when the state row is still readable, else falls back to the defensive max
// range.
export async function removeContentVectors(tenantId, contentId) {
  if (!tenantId || !contentId) return;
  const state = await getContentVectorState(tenantId, contentId);
  const count = state?.chunkCount ?? MAX_CHUNKS_FALLBACK;
  await deleteContentChunkRange(contentId, 0, count);
  logger.info("Removed content vectors", { contentId, count });
}

// Minimal concurrency-bounded map so a long piece embeds in parallel without a
// dependency. Preserves input order in the output.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
