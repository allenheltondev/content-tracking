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

function reportKeyPair(vendorId, reportId) {
  return { pk: `VENDOR#${vendorId}`, sk: `REPORT#${reportId}` };
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
