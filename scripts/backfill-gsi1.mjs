#!/usr/bin/env node
//
// One-shot backfill script.
//
// Before this refactor, Campaign and Vendor records didn't carry GSI1
// keys (gsi1pk / gsi1sk) because GSI1 didn't exist. Now that the API
// reads "list all campaigns" and "list all vendors" exclusively via
// GSI1 Queries, existing records need to be tagged so they show up in
// the index.
//
// Usage:
//   AWS_PROFILE=staging node scripts/backfill-gsi1.mjs --table content-tracking
//   AWS_PROFILE=prod    node scripts/backfill-gsi1.mjs --table content-tracking --apply
//
// Without `--apply` the script runs in dry-run mode: it prints what
// would be updated but doesn't write anything. Run twice — once to
// confirm the count looks right, then again with --apply.
//
// Idempotent. UpdateItem only sets gsi1pk/gsi1sk if they're missing,
// so re-running is safe.

import { DynamoDBClient, paginateScan } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const args = parseArgs(process.argv.slice(2));
if (!args.table) {
  console.error("Usage: backfill-gsi1.mjs --table <name> [--apply] [--region us-east-1]");
  process.exit(1);
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region }));

let scanned = 0;
let needsUpdate = 0;
let updated = 0;

// One-shot use of Scan is acceptable here precisely because this is a
// one-shot migration. After this completes, every new write carries
// gsi1pk/gsi1sk and no further Scans should happen anywhere.
const paginator = paginateScan(
  { client: ddb.config.translateConfig ? ddb : new DynamoDBClient({ region: args.region }), pageSize: 100 },
  {
    TableName: args.table,
    FilterExpression: "(#entity = :campaign OR #entity = :vendor) AND #sk = :metadata",
    ExpressionAttributeNames: { "#entity": "entity", "#sk": "sk" },
    ExpressionAttributeValues: {
      ":campaign": { S: "Campaign" },
      ":vendor": { S: "Vendor" },
      ":metadata": { S: "METADATA" },
    },
  },
);

for await (const page of paginator) {
  for (const rawItem of page.Items ?? []) {
    scanned += 1;

    // Unmarshall just the fields we care about.
    const entity = rawItem.entity?.S;
    const id = entity === "Vendor" ? rawItem.vendorId?.S : rawItem.campaignId?.S;
    const createdAt = rawItem.createdAt?.S;
    const hasGsi1 = !!rawItem.gsi1pk?.S;

    if (!entity || !id || !createdAt) {
      console.warn(`Skipping item missing entity/id/createdAt: pk=${rawItem.pk?.S} sk=${rawItem.sk?.S}`);
      continue;
    }
    if (hasGsi1) continue;

    needsUpdate += 1;
    const gsi1pk = entity === "Vendor" ? "VENDORS" : "CAMPAIGNS";
    const gsi1sk = `${createdAt}#${id}`;

    if (!args.apply) {
      console.log(`[dry-run] would set gsi1pk=${gsi1pk}, gsi1sk=${gsi1sk} on ${rawItem.pk.S}/${rawItem.sk.S}`);
      continue;
    }

    await ddb.send(new UpdateCommand({
      TableName: args.table,
      Key: { pk: rawItem.pk.S, sk: rawItem.sk.S },
      UpdateExpression: "SET gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
      ExpressionAttributeValues: {
        ":gsi1pk": gsi1pk,
        ":gsi1sk": gsi1sk,
      },
      ConditionExpression: "attribute_not_exists(gsi1pk)",
    }));
    updated += 1;
    console.log(`Updated ${rawItem.pk.S}/${rawItem.sk.S} → gsi1pk=${gsi1pk}, gsi1sk=${gsi1sk}`);
  }
}

console.log("---");
console.log(`Scanned: ${scanned}`);
console.log(`Needed update: ${needsUpdate}`);
console.log(`Updated: ${updated}${args.apply ? "" : " (dry-run; use --apply to write)"}`);

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
