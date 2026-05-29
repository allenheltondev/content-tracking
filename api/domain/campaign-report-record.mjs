import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
import { REPORT_RETENTION_DAYS } from "./vendor-report-record.mjs";

// Persistence for generated campaign reports. A report record is an
// immutable pointer to the rendered HTML artifact in S3 plus the metadata
// needed to re-sign a fresh link or render a history list — never the
// report body itself.
//
// Records live alongside the campaign at:
//   pk = CAMPAIGN#{campaignId}, sk = REPORT#{reportId}
// reportId is a ULID, so begins_with(sk, "REPORT#") returns them in
// chronological order. Campaign metadata lives at sk=METADATA, links at
// LINK#..., and social/content posts as their own entities, so the
// REPORT# prefix never collides. They carry NO GSI keys — reports must
// not appear in any cross-cutting list view.
//
// Each record carries a DynamoDB TTL (`expiresAt`, the table's TTL
// attribute) keyed off the same retention window as vendor reports so it
// is purged in lockstep with the S3 lifecycle that deletes the rendered
// HTML object.

function reportKeyPair(campaignId, reportId) {
  return { pk: `CAMPAIGN#${campaignId}`, sk: `REPORT#${reportId}` };
}

export async function saveCampaignReportRecord({
  campaignId,
  reportId,
  key,
  generatedAt,
  dataAsOf,
  summary,
}) {
  // TTL is keyed off generatedAt (epoch seconds) so the record expires
  // when the S3 object does. Fall back to now if generatedAt is
  // unparseable rather than writing a record that never expires. Mirrors
  // the TTL logic in vendor-report-record.mjs.
  const generatedMs = Date.parse(generatedAt);
  const baseSeconds = Number.isNaN(generatedMs)
    ? Math.floor(Date.now() / 1000)
    : Math.floor(generatedMs / 1000);

  const item = {
    ...reportKeyPair(campaignId, reportId),
    entity: "CampaignReport",
    campaignId,
    reportId,
    key,
    generatedAt,
    dataAsOf,
    summary,
    expiresAt: baseSeconds + REPORT_RETENTION_DAYS * 24 * 60 * 60,
  };

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
  }));

  return item;
}

export async function listCampaignReportRecords(campaignId) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `CAMPAIGN#${campaignId}`, ":prefix": "REPORT#" },
  }));
  const items = result.Items ?? [];
  // Newest first. generatedAt is an ISO timestamp so a string compare is
  // a chronological compare.
  return items.sort((a, b) => (b.generatedAt ?? "").localeCompare(a.generatedAt ?? ""));
}
