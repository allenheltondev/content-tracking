#!/usr/bin/env node
//
// One-shot seed: turn the existing blog catalog into "voice samples" for the
// blog platform, so the blog voice profile has a corpus on day one. New posts
// (blog or social) are captured going forward via POST /voice/samples; this
// bootstraps the back catalog.
//
// Usage:
//   AWS_PROFILE=staging node scripts/seed-voice-from-blogs.mjs --table content-tracking --region us-east-1
//     ^ dry-run: lists the blogs it would seed
//   ...same... --apply
//     ^ writes a VoiceSample row per blog (platform=blog, source=blog-seed)
//
// Each row's id is derived deterministically from the blog id, so re-running is
// idempotent: a re-seed overwrites the same row (a stream MODIFY, which the
// voice-memory consumer ignores) rather than duplicating or re-embedding.
//
// Vectorization + reflection happen ASYNCHRONOUSLY: createVoiceSample writes a
// DynamoDB row, the deployed VoiceMemoryFunction (stream consumer) embeds it,
// counts it, and reflects the blog profile once the threshold is crossed. So
// the target stack must be deployed for the seed to take effect.

import { DynamoDBClient, paginateScan } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const args = parseArgs(process.argv.slice(2));
if (!args.table) {
  console.error("Usage: seed-voice-from-blogs.mjs --table <name> [--apply] [--region us-east-1] [--max-chars 4000]");
  process.exit(1);
}

// createVoiceSample reads TABLE_NAME at import time (via services/ddb.mjs), so
// set it BEFORE importing the domain module.
process.env.TABLE_NAME = args.table;
process.env.AWS_REGION = process.env.AWS_REGION || args.region;

const { createVoiceSample } = await import("../api/domain/voice.mjs");

const client = new DynamoDBClient({ region: args.region });

let scanned = 0;
let seeded = 0;

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
    const text = buildSampleText(blog, args.maxChars);
    if (!text) {
      console.warn(`Skipping ${blog.blogId}: no text`);
      continue;
    }

    if (!args.apply) {
      console.log(`[dry-run] would seed ${blog.tenantId}/${blog.blogId} — "${blog.title ?? "(untitled)"}"`);
      continue;
    }

    await createVoiceSample(blog.tenantId, {
      text,
      platform: "blog",
      format: "blog",
      source: "blog-seed",
      // Deterministic id → re-runs overwrite instead of duplicating.
      sampleId: `BLOG-${blog.blogId}`,
    });
    seeded += 1;
    console.log(`Seeded ${blog.blogId}`);
  }
}

console.log("---");
console.log(`Scanned blogs: ${scanned}`);
if (args.apply) {
  console.log(`Seeded samples: ${seeded}`);
  console.log("Vectorization + reflection run asynchronously via VoiceMemoryFunction.");
} else {
  console.log("(dry-run; use --apply to write voice samples)");
}

// A blog "voice sample" should be representative prose, not the whole (up to
// 300KB) body — title + description + a leading excerpt captures the voice
// without bloating the vector/metadata.
function buildSampleText(blog, maxChars) {
  const parts = [blog.title, blog.description, (blog.contentMarkdown ?? "").slice(0, maxChars)]
    .filter((s) => typeof s === "string" && s.trim().length > 0);
  return parts.join("\n\n").trim();
}

function parseArgs(argv) {
  const out = { region: "us-east-1", apply: false, maxChars: 4000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--table") out.table = argv[++i];
    else if (arg === "--region") out.region = argv[++i];
    else if (arg === "--max-chars") out.maxChars = Number(argv[++i]);
  }
  return out;
}
