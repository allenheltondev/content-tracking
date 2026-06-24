import {
  S3VectorsClient,
  PutVectorsCommand,
  DeleteVectorsCommand,
  QueryVectorsCommand,
} from "@aws-sdk/client-s3vectors";
import { logger } from "./logger.mjs";

// S3 Vectors wrapper for the "voice" episodic memory. Sibling of
// blog-vectors.mjs but a separate index: voice samples are short whole posts
// (one vector each, no chunking) and are retrieved as few-shot style examples,
// whereas blog-vectors holds chunked long-form for /blogs/ask. Both indexes
// live in the same bucket (VECTOR_BUCKET_NAME).
//
// Vector key:  `${tenantId}#${platform}#${sampleId}` — deterministic, so a
//              re-put overwrites in place and delete needs no list/scan.
// Metadata:    filterable { tenantId, platform, format } so a query scopes to
//              one tenant+platform; non-filterable { text } carries the sample
//              body back for use as a few-shot example.

const BUCKET = process.env.VECTOR_BUCKET_NAME;
const INDEX = process.env.VOICE_VECTOR_INDEX_NAME;

const client = new S3VectorsClient({});

export function voiceVectorKey(tenantId, platform, sampleId) {
  return `${tenantId}#${platform}#${sampleId}`;
}

function assertConfigured() {
  if (!BUCKET || !INDEX) {
    throw new Error("VECTOR_BUCKET_NAME / VOICE_VECTOR_INDEX_NAME env vars are not set");
  }
}

// Upserts the embedding for one voice sample.
export async function putVoiceSample({ tenantId, platform, format, sampleId, text, embedding }) {
  assertConfigured();
  await client.send(new PutVectorsCommand({
    vectorBucketName: BUCKET,
    indexName: INDEX,
    vectors: [{
      key: voiceVectorKey(tenantId, platform, sampleId),
      data: { float32: embedding },
      metadata: { tenantId, platform, format: format ?? "", text },
    }],
  }));
  logger.info("Put voice sample vector", { platform, sampleId });
}

// Nearest-neighbour search over a tenant's samples for one platform — the
// few-shot examples for compose. returnMetadata / a filter both require
// s3vectors:GetVectors alongside QueryVectors.
export async function queryVoiceSamples({ tenantId, queryEmbedding, platform, topK = 5 }) {
  assertConfigured();
  if (!tenantId || !platform) throw new Error("queryVoiceSamples requires tenantId and platform");

  const res = await client.send(new QueryVectorsCommand({
    vectorBucketName: BUCKET,
    indexName: INDEX,
    topK,
    queryVector: { float32: queryEmbedding },
    filter: { tenantId, platform },
    returnMetadata: true,
    returnDistance: true,
  }));

  return (res.vectors ?? []).map((v) => ({
    key: v.key,
    distance: v.distance,
    text: v.metadata?.text,
    format: v.metadata?.format,
  }));
}

export async function deleteVoiceSample({ tenantId, platform, sampleId }) {
  assertConfigured();
  await client.send(new DeleteVectorsCommand({
    vectorBucketName: BUCKET,
    indexName: INDEX,
    keys: [voiceVectorKey(tenantId, platform, sampleId)],
  }));
  logger.info("Deleted voice sample vector", { platform, sampleId });
}
