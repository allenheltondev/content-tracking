#!/usr/bin/env node
//
// One-shot backfill: vectorize every existing blog post so the catalog that
// predates the stream-driven vectorizer becomes searchable. New and edited
// posts are handled live by functions/vectorize-blog via DynamoDB Streams;
// this covers the back catalog.
//
// Usage:
//   AWS_PROFILE=staging node scripts/backfill-blog-vectors.mjs \
//     --table content-tracking \
//     --bucket content-tracking-blog-vectors-staging-<acct> \
//     --index blog-vectors \
//     --region us-east-1            # dry-run: lists what would be embedded
//
//   ...same... --apply               # actually embeds + writes vectors
//
// Idempotent: the vectorizer hashes each post's text and skips unchanged
// content, so re-running only embeds posts that are new or changed since the
// last run.

import { DynamoDBClient, paginateScan } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const args = parseArgs(process.argv.slice(2));
if (!args.table || !args.bucket || !args.index) {
  console.error(
    "Usage: backfill-blog-vectors.mjs --table <name> --bucket <vectorBucket> --index <vectorIndex> [--apply] [--region us-east-1] [--model amazon.titan-embed-text-v2:0]",
  );
  process.exit(1);
}

// The vectorize core and its services read their config from env at import
// time (TABLE_NAME, VECTOR_BUCKET_NAME, VECTOR_INDEX_NAME, EMBEDDING_MODEL_ID,
// BEDROCK_REGION), so set them BEFORE importing the core below.
process.env.TABLE_NAME = args.table;
process.env.VECTOR_BUCKET_NAME = args.bucket;
process.env.VECTOR_INDEX_NAME = args.index;
process.env.BEDROCK_REGION = process.env.BEDROCK_REGION || args.region;
if (args.model) process.env.EMBEDDING_MODEL_ID = args.model;

const { vectorizeBlog } = await import("../functions/vectorize-blog/vectorize.mjs");

const client = new DynamoDBClient({ region: args.region });

let scanned = 0;
let embedded = 0;
let skipped = 0;
let failed = 0;

// One-shot Scan is acceptable for a migration. Filter to blog ROOT items
// (entity = "Blog"); child rows carry a different entity.
const paginator = paginateScan(
  { client, pageSize: 100 },
  {
    TableName: args.table,
    FilterExpression: "#entity = :blog",
    ExpressionAttributeNames: { "#entity": "entity" },
    ExpressionAttributeValues: { ":blog": { S: "Blog" } },
  },
);

for await (const page of paginator) {
  for (const rawItem of page.Items ?? []) {
    scanned += 1;
    const blog = unmarshall(rawItem);

    if (!args.apply) {
      console.log(`[dry-run] would vectorize ${blog.tenantId}/${blog.blogId} — "${blog.title ?? "(untitled)"}"`);
      continue;
    }

    try {
      const result = await vectorizeBlog(blog);
      if (result.skipped) {
        skipped += 1;
        console.log(`Skipped ${blog.blogId} (${result.reason})`);
      } else {
        embedded += 1;
        console.log(`Vectorized ${blog.blogId} → ${result.chunkCount} chunks`);
      }
    } catch (err) {
      failed += 1;
      console.error(`FAILED ${blog.blogId}: ${err?.message ?? err}`);
    }
  }
}

console.log("---");
console.log(`Scanned blogs: ${scanned}`);
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
