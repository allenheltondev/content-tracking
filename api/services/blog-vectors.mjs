import {
  S3VectorsClient,
  PutVectorsCommand,
  DeleteVectorsCommand,
  QueryVectorsCommand,
} from "@aws-sdk/client-s3vectors";
import { logger } from "./logger.mjs";

// Thin wrapper over the S3 Vectors data API for blog chunk vectors. Centralizes
// the bucket/index names, the vector key shape, and the metadata layout so the
// ingestion Lambda (and the future query path) don't repeat them.
//
// Vector key:    `${blogId}#${chunkIndex}` — deterministic, so re-embedding a
//                blog overwrites its chunks in place and stale tail chunks can
//                be deleted by computed key without a list/scan.
// Metadata:      filterable { tenantId, blogId, slug, title, chunkIndex } so a
//                query can scope to a tenant/post; non-filterable { text } holds
//                the chunk body for the LLM to read back. `text` is declared
//                non-filterable at index-create time so it doesn't count against
//                the 2 KB filterable-metadata budget (40 KB total per vector).

const BUCKET = process.env.VECTOR_BUCKET_NAME;
const INDEX = process.env.VECTOR_INDEX_NAME;

// PutVectors and DeleteVectors cap how many entries one request may carry;
// stay well under to keep request bodies modest (each vector is ~4 KB of
// floats plus metadata).
const PUT_BATCH = 100;
const DELETE_BATCH = 200;

const client = new S3VectorsClient({});

export function vectorKey(blogId, chunkIndex) {
  return `${blogId}#${chunkIndex}`;
}

// Upserts the embedded chunks for one blog. `chunks` is
// [{ index, text, embedding }]. Overwrites any existing vector at the same key.
export async function putBlogChunks({ tenantId, blogId, slug, title, chunks }) {
  if (!BUCKET || !INDEX) {
    throw new Error("VECTOR_BUCKET_NAME / VECTOR_INDEX_NAME env vars are not set");
  }
  if (chunks.length === 0) return;

  const vectors = chunks.map((c) => ({
    key: vectorKey(blogId, c.index),
    data: { float32: c.embedding },
    metadata: {
      tenantId,
      blogId,
      slug: slug ?? "",
      title: title ?? "",
      chunkIndex: c.index,
      text: c.text,
    },
  }));

  for (let i = 0; i < vectors.length; i += PUT_BATCH) {
    const batch = vectors.slice(i, i + PUT_BATCH);
    await client.send(new PutVectorsCommand({
      vectorBucketName: BUCKET,
      indexName: INDEX,
      vectors: batch,
    }));
  }

  logger.info("Put blog chunk vectors", { blogId, count: vectors.length });
}

// Nearest-neighbour search over a tenant's blog chunks. `queryEmbedding` is
// the embedded question; the metadata filter scopes results to the caller's
// tenant (and optionally one blog) so a query never leaks across tenants.
// Returns the matched chunks with their distance, closest first.
//
// Note: returnMetadata / a filter both require s3vectors:GetVectors in
// addition to s3vectors:QueryVectors on the caller's IAM.
export async function queryBlogChunks({ tenantId, queryEmbedding, topK = 8, blogId }) {
  if (!BUCKET || !INDEX) {
    throw new Error("VECTOR_BUCKET_NAME / VECTOR_INDEX_NAME env vars are not set");
  }
  if (!tenantId) throw new Error("queryBlogChunks requires a tenantId");

  // Implicit AND across keys: tenantId always, blogId when narrowing to a post.
  const filter = { tenantId };
  if (blogId) filter.blogId = blogId;

  const res = await client.send(new QueryVectorsCommand({
    vectorBucketName: BUCKET,
    indexName: INDEX,
    topK,
    queryVector: { float32: queryEmbedding },
    filter,
    returnMetadata: true,
    returnDistance: true,
  }));

  return (res.vectors ?? []).map((v) => ({
    key: v.key,
    distance: v.distance,
    blogId: v.metadata?.blogId,
    title: v.metadata?.title,
    slug: v.metadata?.slug,
    chunkIndex: v.metadata?.chunkIndex,
    text: v.metadata?.text,
  }));
}

// Deletes the vectors for chunk indices in [fromIndex, toIndex). Used both to
// trim stale tail chunks after a shrinking edit and (from 0) to remove a blog
// entirely. DeleteVectors ignores keys that don't exist, so an over-wide range
// is safe and idempotent.
export async function deleteBlogChunkRange(blogId, fromIndex, toIndex) {
  if (!BUCKET || !INDEX) {
    throw new Error("VECTOR_BUCKET_NAME / VECTOR_INDEX_NAME env vars are not set");
  }
  if (toIndex <= fromIndex) return;

  const keys = [];
  for (let i = fromIndex; i < toIndex; i++) keys.push(vectorKey(blogId, i));

  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    const batch = keys.slice(i, i + DELETE_BATCH);
    await client.send(new DeleteVectorsCommand({
      vectorBucketName: BUCKET,
      indexName: INDEX,
      keys: batch,
    }));
  }

  logger.info("Deleted blog chunk vectors", { blogId, from: fromIndex, to: toIndex });
}
