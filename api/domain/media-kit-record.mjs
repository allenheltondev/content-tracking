import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
import { REPORT_RETENTION_DAYS } from "./vendor-report-record.mjs";

// Persistence for generated media kits. Like the report records, a media-kit
// record is an immutable pointer to the rendered HTML artifact in S3 plus
// the metadata needed to re-sign a fresh link or render a history list —
// never the body itself.
//
// The stack is single-tenant, so every media kit shares one partition:
//   pk = MEDIAKIT, sk = REPORT#{reportId}
// reportId is a ULID, so begins_with(sk, "REPORT#") returns them in
// chronological order. They carry NO GSI keys.
//
// Each record carries a DynamoDB TTL (`expiresAt`, the table's TTL
// attribute) keyed off the same retention window as the reports so it is
// purged in lockstep with the S3 lifecycle that deletes the HTML object.

const MEDIA_KIT_PARTITION = "MEDIAKIT";

function recordKeyPair(reportId) {
  return { pk: MEDIA_KIT_PARTITION, sk: `REPORT#${reportId}` };
}

export async function saveMediaKitRecord({ reportId, key, generatedAt, dataAsOf, stats }) {
  // TTL keyed off generatedAt (epoch seconds) so the record expires when the
  // S3 object does. Fall back to now if generatedAt is unparseable rather
  // than writing a record that never expires.
  const generatedMs = Date.parse(generatedAt);
  const baseSeconds = Number.isNaN(generatedMs)
    ? Math.floor(Date.now() / 1000)
    : Math.floor(generatedMs / 1000);

  const item = {
    ...recordKeyPair(reportId),
    entity: "MediaKit",
    reportId,
    key,
    generatedAt,
    dataAsOf,
    stats,
    expiresAt: baseSeconds + REPORT_RETENTION_DAYS * 24 * 60 * 60,
  };

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
  }));

  return item;
}

export async function listMediaKitRecords() {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": MEDIA_KIT_PARTITION, ":prefix": "REPORT#" },
  }));
  const items = result.Items ?? [];
  // Newest first. generatedAt is an ISO timestamp so a string compare is a
  // chronological compare.
  return items.sort((a, b) => (b.generatedAt ?? "").localeCompare(a.generatedAt ?? ""));
}
