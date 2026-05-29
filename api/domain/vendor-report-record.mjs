import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";

// Persistence for generated vendor reports. A report record is an
// immutable pointer to the rendered HTML artifact in S3 plus the metadata
// needed to re-sign a fresh link or render a history list — never the
// report body itself.
//
// Records live alongside the vendor at:
//   pk = VENDOR#{vendorId}, sk = REPORT#{reportId}
// reportId is a ULID, so begins_with(sk, "REPORT#") returns them in
// chronological order. They carry NO GSI1 keys — reports must not appear
// in any "list all vendors" view.
//
// Each record carries a DynamoDB TTL (`expiresAt`, the table's TTL
// attribute) so it is purged in lockstep with the S3 lifecycle that
// deletes the rendered HTML object. Without this the record would outlive
// its object and the list endpoint would re-sign a link to a missing
// object. Retention must equal the bucket lifecycle in template.yaml —
// both read VendorReportsRetentionDays.
export const REPORT_RETENTION_DAYS = Number(process.env.VENDOR_REPORTS_RETENTION_DAYS) || 90;
const RETENTION_MS = REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function reportKeyPair(vendorId, reportId) {
  return { pk: `VENDOR#${vendorId}`, sk: `REPORT#${reportId}` };
}

// Epoch milliseconds after which the S3 object backing this record has been
// (or will be) deleted by the bucket lifecycle. Callers use this to avoid
// handing out a signed link to an object that won't survive the link's
// lifetime. Returns 0 for a record with an unparseable generatedAt so it is
// treated as already expired.
export function reportObjectExpiresAtMs(record) {
  const generatedMs = Date.parse(record?.generatedAt ?? "");
  return Number.isNaN(generatedMs) ? 0 : generatedMs + RETENTION_MS;
}

export async function saveReportRecord({
  vendorId,
  reportId,
  key,
  generatedAt,
  dataAsOf,
  period,
  currency,
  summary,
}) {
  // TTL is keyed off generatedAt (epoch seconds) so the record expires
  // when the S3 object does. Fall back to now if generatedAt is unparseable
  // rather than writing a record that never expires.
  const generatedMs = Date.parse(generatedAt);
  const baseSeconds = Number.isNaN(generatedMs)
    ? Math.floor(Date.now() / 1000)
    : Math.floor(generatedMs / 1000);

  const item = {
    ...reportKeyPair(vendorId, reportId),
    entity: "VendorReport",
    vendorId,
    reportId,
    key,
    generatedAt,
    dataAsOf,
    period,
    currency,
    summary,
    expiresAt: baseSeconds + REPORT_RETENTION_DAYS * 24 * 60 * 60,
  };

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
  }));

  return item;
}

export async function listReportRecords(vendorId) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `VENDOR#${vendorId}`, ":prefix": "REPORT#" },
  }));
  const items = result.Items ?? [];
  // Newest first. generatedAt is an ISO timestamp so a string compare is
  // a chronological compare.
  return items.sort((a, b) => (b.generatedAt ?? "").localeCompare(a.generatedAt ?? ""));
}
