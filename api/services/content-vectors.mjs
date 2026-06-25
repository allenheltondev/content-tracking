import {
  S3VectorsClient,
  PutVectorsCommand,
  DeleteVectorsCommand,
  QueryVectorsCommand,
} from "@aws-sdk/client-s3vectors";
import { logger } from "./logger.mjs";

// Thin wrapper over the S3 Vectors data API for content chunk vectors.
// Centralizes the bucket/index names, the vector key shape, and the metadata
// layout so the ingestion Lambda (and the future query path) don't repeat them.
//
// Vector key:    `${contentId}#${chunkIndex}` — deterministic, so re-embedding
//                a piece of content overwrites its chunks in place and stale
//                tail chunks can be deleted by computed key without a
//                list/scan.
// Metadata:      filterable { tenantId, contentId, type, title, slug,
//                chunkIndex } so a query can scope to a tenant/piece/type;
//                non-filterable { text } holds the chunk body for the LLM to
//                read back. `text` is declared non-filterable at index-create
//                time so it doesn't count against the 2 KB filterable-metadata
//                budget (40 KB total per vector).

const BUCKET = process.env.VECTOR_BUCKET_NAME;
const INDEX = process.env.CONTENT_VECTOR_INDEX_NAME;

// PutVectors and DeleteVectors cap how many entries one request may carry;
// stay well under to keep request bodies modest (each vector is ~4 KB of
// floats plus metadata).
const PUT_BATCH = 100;
const DELETE_BATCH = 200;

const client = new S3VectorsClient({});

export function contentVectorKey(contentId, chunkIndex) {
  return `${contentId}#${chunkIndex}`;
}

// Upserts the embedded chunks for one piece of content. `chunks` is
// [{ index, text, embedding }]. Overwrites any existing vector at the same key.
export async function putContentChunks({ tenantId, contentId, type, title, slug, chunks }) {
  if (!BUCKET || !INDEX) {
    throw new Error("VECTOR_BUCKET_NAME / CONTENT_VECTOR_INDEX_NAME env vars are not set");
  }
  if (chunks.length === 0) return;

  const vectors = chunks.map((c) => ({
    key: contentVectorKey(contentId, c.index),
    data: { float32: c.embedding },
    metadata: {
      tenantId,
      contentId,
      type: type ?? "",
      title: title ?? "",
      slug: slug ?? "",
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

  logger.info("Put content chunk vectors", { contentId, count: vectors.length });
}

// Nearest-neighbour search over a tenant's content chunks. `queryEmbedding` is
// the embedded question; the metadata filter scopes results to the caller's
// tenant (and optionally one piece of content or one type) so a query never
// leaks across tenants. Returns the matched chunks with their distance,
// closest first.
//
// Note: returnMetadata / a filter both require s3vectors:GetVectors in
// addition to s3vectors:QueryVectors on the caller's IAM.
export async function queryContentChunks({ tenantId, queryEmbedding, topK = 8, contentId, type }) {
  if (!BUCKET || !INDEX) {
    throw new Error("VECTOR_BUCKET_NAME / CONTENT_VECTOR_INDEX_NAME env vars are not set");
  }
  if (!tenantId) throw new Error("queryContentChunks requires a tenantId");

  // Implicit AND across keys: tenantId always, contentId/type when narrowing.
  const filter = { tenantId };
  if (contentId) filter.contentId = contentId;
  if (type) filter.type = type;

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
    contentId: v.metadata?.contentId,
    type: v.metadata?.type,
    title: v.metadata?.title,
    slug: v.metadata?.slug,
    chunkIndex: v.metadata?.chunkIndex,
    text: v.metadata?.text,
  }));
}

// Deletes the vectors for chunk indices in [fromIndex, toIndex). Used both to
// trim stale tail chunks after a shrinking edit and (from 0) to remove a piece
// of content entirely. DeleteVectors ignores keys that don't exist, so an
// over-wide range is safe and idempotent.
export async function deleteContentChunkRange(contentId, fromIndex, toIndex) {
  if (!BUCKET || !INDEX) {
    throw new Error("VECTOR_BUCKET_NAME / CONTENT_VECTOR_INDEX_NAME env vars are not set");
  }
  if (toIndex <= fromIndex) return;

  const keys = [];
  for (let i = fromIndex; i < toIndex; i++) keys.push(contentVectorKey(contentId, i));

  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    const batch = keys.slice(i, i + DELETE_BATCH);
    await client.send(new DeleteVectorsCommand({
      vectorBucketName: BUCKET,
      indexName: INDEX,
      keys: batch,
    }));
  }

  logger.info("Deleted content chunk vectors", { contentId, from: fromIndex, to: toIndex });
}
