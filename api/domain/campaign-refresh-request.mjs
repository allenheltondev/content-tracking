import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_NAME, ddb, isConditionalCheckFailed } from "../services/ddb.mjs";
import { tenantPartition } from "./blog.mjs";

// A sponsor's request to refresh a monitoring campaign's extension-sourced
// stats (social posts and content posts). The public refresh route records
// one; the Chrome extension reads pending requests from the monitoring
// working set, re-scrapes the campaign's posts, and clears the request when
// it reports the sweep complete.
//
// Storage (one row per campaign, so repeat requests collapse):
//   pk = TENANT#{tenantId}, sk = REFRESHREQUEST#{campaignId}
//   entity = "CampaignRefreshRequest"
//
// Each row carries the table's TTL attribute (`expiresAt`, epoch seconds)
// so a request the extension never picks up ages out on its own. DynamoDB
// deletes expired items lazily, so reads and writes also treat a row past
// its expiresAt as absent.

const SK_PREFIX = "REFRESHREQUEST#";

export const REFRESH_REQUEST_TTL_DAYS = 3;
const TTL_SECONDS = REFRESH_REQUEST_TTL_DAYS * 24 * 60 * 60;

export function refreshRequestKey(tenantId, campaignId) {
  return { pk: tenantPartition(tenantId), sk: `${SK_PREFIX}${campaignId}` };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isLive(item, nowSec = nowSeconds()) {
  return Boolean(item) && (typeof item.expiresAt !== "number" || item.expiresAt > nowSec);
}

// Records a pending request. A live request already on file wins, so the
// earliest requestedAt is kept and repeat submissions cost one failed
// conditional write. Returns true when this call created the request.
export async function recordRefreshRequest(tenantId, campaignId) {
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...refreshRequestKey(tenantId, campaignId),
        entity: "CampaignRefreshRequest",
        tenantId,
        campaignId,
        requestedAt: now.toISOString(),
        expiresAt: nowSec + TTL_SECONDS,
      },
      ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :nowSec",
      ExpressionAttributeValues: { ":nowSec": nowSec },
    }));
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

// Every live request for the tenant, oldest request first. One row per
// campaign keeps this tiny, but every page is read so none are dropped.
export async function listPendingRefreshRequests(tenantId) {
  const nowSec = nowSeconds();
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": tenantPartition(tenantId), ":prefix": SK_PREFIX },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of result.Items ?? []) {
      if (isLive(item, nowSec)) items.push(item);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
}

// The campaign's live request, or null.
export async function getRefreshRequest(tenantId, campaignId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: refreshRequestKey(tenantId, campaignId),
  }));
  return isLive(result.Item) ? result.Item : null;
}

// Removes the campaign's request, but only the one the caller read (matched
// on requestedAt), so a request recorded after the caller looked survives
// for the next sweep. Returns false when the row was gone or replaced.
export async function clearRefreshRequest(tenantId, campaignId, requestedAt) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: refreshRequestKey(tenantId, campaignId),
      ConditionExpression: "requestedAt = :requestedAt",
      ExpressionAttributeValues: { ":requestedAt": requestedAt },
    }));
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}
