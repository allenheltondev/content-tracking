#!/usr/bin/env node
//
// One-shot backfill: run the voice auto-capture over the existing Content
// catalog, so the recency-weighted blog voice profile has the full published
// history (with real publish dates) on day one. Going forward this is
// automatic — VoiceMemoryFunction captures published blog Content off the
// table stream as it's created/edited.
//
// Usage:
//   AWS_PROFILE=staging node scripts/seed-voice-from-content.mjs --table content-tracking --region us-east-1
//     ^ dry-run: lists the published blog content it would capture
//   ...same... --apply
//     ^ writes a VoiceSample row per piece (platform=blog, source=content-auto,
//       publishedAt = publishDate ?? createdAt)
//
// Sample ids are deterministic (CONTENT-{contentId}), so re-running overwrites
// the same rows. A re-run with UNCHANGED text is a stream MODIFY the consumer
// skips (no re-embed); changed text re-embeds and counts as fresh signal.
//
// Vectorization + reflection happen ASYNCHRONOUSLY via the deployed
// VoiceMemoryFunction, so the target stack must be deployed for the seed to
// take effect.

import { DynamoDBClient, paginateScan } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const args = parseArgs(process.argv.slice(2));
if (!args.table) {
  console.error("Usage: seed-voice-from-content.mjs --table <name> [--apply] [--region us-east-1]");
  process.exit(1);
}

// The domain module reads TABLE_NAME + AWS_REGION at import time (via
// services/ddb.mjs), so set them BEFORE importing the service module. AWS_REGION
// is set UNCONDITIONALLY from --region so the writer targets the SAME region the
// scan reads — a pre-existing AWS_REGION in the shell must not silently redirect
// writes to a different environment's table of the same name.
process.env.TABLE_NAME = args.table;
process.env.AWS_REGION = args.region;

const { captureContentVoiceSample, isVoiceEligibleContent } = await import("../api/services/voice-memory.mjs");

const client = new DynamoDBClient({ region: args.region });

let scanned = 0;
let eligible = 0;
let captured = 0;

const paginator = paginateScan(
  { client, pageSize: 100 },
  {
    TableName: args.table,
    FilterExpression: "#entity = :content AND #type = :blog",
    ExpressionAttributeNames: { "#entity": "entity", "#type": "type" },
    ExpressionAttributeValues: { ":content": { S: "Content" }, ":blog": { S: "blog" } },
  },
);

for await (const page of paginator) {
  for (const rawItem of page.Items ?? []) {
    scanned += 1;
    const content = unmarshall(rawItem);
    if (!isVoiceEligibleContent(content)) {
      console.warn(`Skipping ${content.contentId}: not eligible (status=${content.status ?? "?"})`);
      continue;
    }
    eligible += 1;

    const anchor = content.publishDate ?? content.createdAt;
    if (!args.apply) {
      console.log(`[dry-run] would capture ${content.tenantId}/${content.contentId} — "${content.title ?? "(untitled)"}" (published ${anchor})`);
      continue;
    }

    const result = await captureContentVoiceSample(content);
    if (!result.skipped) {
      captured += 1;
      console.log(`Captured ${content.contentId} (published ${anchor})`);
    }
  }
}

console.log("---");
console.log(`Scanned blog content: ${scanned} (eligible: ${eligible})`);
if (args.apply) {
  console.log(`Captured samples: ${captured}`);
  console.log("Vectorization + recency-weighted reflection run asynchronously via VoiceMemoryFunction.");
} else {
  console.log("(dry-run; use --apply to write voice samples)");
}

function parseArgs(argv) {
  const out = { region: "us-east-1", apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--table") out.table = argv[++i];
    else if (arg === "--region") out.region = argv[++i];
  }
  return out;
}
