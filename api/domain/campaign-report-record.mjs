import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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

// Yields a campaign's report records newest-first, one Query page at a time.
// The sk is REPORT#{ulid}, so a descending key order is a newest-first order
// and callers looking for "the latest X" can stop after the first match
// instead of reading the whole partition.
async function* campaignReportRecordsNewestFirst(campaignId) {
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `CAMPAIGN#${campaignId}`, ":prefix": "REPORT#" },
      ScanIndexForward: false,
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of result.Items ?? []) yield item;
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
}

// Every retained report record, newest first. Retention bounds the
// partition, but a campaign regenerated often can still exceed one page, so
// every page is read.
export async function listCampaignReportRecords(campaignId) {
  const items = [];
  for await (const item of campaignReportRecordsNewestFirst(campaignId)) items.push(item);
  return items;
}

// The newest record satisfying `predicate`, or null. Stops paging as soon as
// one matches.
export async function findNewestCampaignReportRecord(campaignId, predicate) {
  for await (const item of campaignReportRecordsNewestFirst(campaignId)) {
    if (predicate(item)) return item;
  }
  return null;
}

// Claims the right to banner a report as superseded by `byReportId`. The
// claim is monotonic: it succeeds only when no generation has claimed the
// report yet or the existing claimant is older (ULIDs sort by time), so an
// older generation can never take a report back from a newer one. Returns
// false when a newer generation already holds it. The attribute_exists guard
// keeps a record that aged out mid-flight from being resurrected as a
// TTL-less stub.
export async function claimCampaignReportSupersede(campaignId, reportId, { byReportId, supersededAt }) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: reportKeyPair(campaignId, reportId),
      UpdateExpression: "SET supersededByReportId = :by, supersededAt = :at",
      ConditionExpression:
        "attribute_exists(pk) AND (attribute_not_exists(supersededByReportId) OR supersededByReportId < :by)",
      ExpressionAttributeValues: { ":by": byReportId, ":at": supersededAt },
    }));
    return true;
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

// Undoes a claim whose rewrite failed, so the next generation retries it.
// Only removes the claim if `byReportId` still holds it.
export async function releaseCampaignReportSupersede(campaignId, reportId, byReportId) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: reportKeyPair(campaignId, reportId),
      UpdateExpression: "REMOVE supersededByReportId, supersededAt",
      ConditionExpression: "supersededByReportId = :by",
      ExpressionAttributeValues: { ":by": byReportId },
    }));
  } catch (err) {
    if (err?.name !== "ConditionalCheckFailedException") throw err;
  }
}

// Strongly consistent read of one report record, used to confirm who holds
// a supersede claim after a rewrite.
export async function getCampaignReportRecord(campaignId, reportId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: reportKeyPair(campaignId, reportId),
    ConsistentRead: true,
  }));
  return result.Item ?? null;
}
