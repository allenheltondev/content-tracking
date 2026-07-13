#!/usr/bin/env node
//
// One-shot backfill: vectorize every existing Content row so the unified
// catalog becomes searchable in the content-vectors index. New and edited
// Content is handled live by functions/vectorize-content via DynamoDB Streams,
// and the entity migrations (migrate-blogs-to-content / migrate-campaign-posts-
// to-content) trigger that same stream when they write Content rows — so this
// script is NOT required to light up a fresh migration. It's the explicit
// (re)build tool for the cases the stream doesn't cover: recreating the index,
// recovering missed stream events / DLQ drops, or vectorizing Content that was
// authored natively and never made it into the index.
//
// Usage:
//   AWS_PROFILE=staging node scripts/backfill-content-vectors.mjs \
//     --table content-tracking \
//     --bucket content-tracking-blog-vectors-staging-<acct> \
//     --index content-vectors \
//     --region us-east-1            # dry-run: lists what would be embedded
//
//   ...same... --apply               # actually embeds + writes vectors
//
// Idempotent: the vectorizer hashes each row's text and skips unchanged
// content, so re-running only embeds Content that is new or changed since the
// last run.

import { DynamoDBClient, paginateScan } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const args = parseArgs(process.argv.slice(2));
if (!args.table || !args.bucket || !args.index) {
  console.error(
    "Usage: backfill-content-vectors.mjs --table <name> --bucket <vectorBucket> --index <vectorIndex> [--apply] [--region us-east-1] [--model amazon.titan-embed-text-v2:0]",
  );
  process.exit(1);
}

// The vectorize core and its services read their config from env at import
// time (TABLE_NAME, VECTOR_BUCKET_NAME, CONTENT_VECTOR_INDEX_NAME,
// EMBEDDING_MODEL_ID, BEDROCK_REGION), so set them BEFORE importing the core
// below. Note the index env var is CONTENT_VECTOR_INDEX_NAME (the content
// service's name), distinct from the voice service's VOICE_VECTOR_INDEX_NAME.
process.env.TABLE_NAME = args.table;
process.env.VECTOR_BUCKET_NAME = args.bucket;
process.env.CONTENT_VECTOR_INDEX_NAME = args.index;
process.env.BEDROCK_REGION = process.env.BEDROCK_REGION || args.region;
if (args.model) process.env.EMBEDDING_MODEL_ID = args.model;

const { vectorizeContent } = await import("../functions/vectorize-content/vectorize.mjs");

const client = new DynamoDBClient({ region: args.region });

let scanned = 0;
let embedded = 0;
let skipped = 0;
let failed = 0;

// One-shot Scan is acceptable for a backfill. Filter to Content ROOT items
// (entity = "Content"); child rows (ContentPublish/ContentStats/
// ContentVectorIndex) carry a different entity.
const paginator = paginateScan(
  { client, pageSize: 100 },
  {
    TableName: args.table,
    FilterExpression: "#entity = :content",
    ExpressionAttributeNames: { "#entity": "entity" },
    ExpressionAttributeValues: { ":content": { S: "Content" } },
  },
);

for await (const page of paginator) {
  for (const rawItem of page.Items ?? []) {
    scanned += 1;
    const content = unmarshall(rawItem);

    if (!args.apply) {
      console.log(
        `[dry-run] would vectorize ${content.tenantId}/${content.contentId} ` +
          `(type=${content.type ?? "?"}) — "${content.title ?? "(untitled)"}"`,
      );
      continue;
    }

    try {
      const result = await vectorizeContent(content);
      if (result.skipped) {
        skipped += 1;
        console.log(`Skipped ${content.contentId} (${result.reason})`);
      } else {
        embedded += 1;
        console.log(`Vectorized ${content.contentId} → ${result.chunkCount} chunks`);
      }
    } catch (err) {
      failed += 1;
      console.error(`FAILED ${content.contentId}: ${err?.message ?? err}`);
    }
  }
}

console.log("---");
console.log(`Scanned content: ${scanned}`);
if (args.apply) {
  console.log(`Vectorized: ${embedded}`);
  console.log(`Skipped (unchanged/empty): ${skipped}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
} else {
  console.log("(dry-run; use --apply to embed and write vectors)");
}

function parseArgs(argv) {
  const out = { region: "us-east-1", apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--table") out.table = argv[++i];
    else if (arg === "--bucket") out.bucket = argv[++i];
    else if (arg === "--index") out.index = argv[++i];
    else if (arg === "--region") out.region = argv[++i];
    else if (arg === "--model") out.model = argv[++i];
  }
  return out;
}
