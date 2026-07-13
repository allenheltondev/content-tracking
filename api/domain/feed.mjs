import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
import { NotFoundError } from "../services/errors.mjs";
import { tenantPartition } from "./blog.mjs";

// Content Radar: the set of RSS/Atom feeds a creator subscribes to so the
// idea-generation agent can see what the wider world is publishing. Sources
// are tenant-scoped by partition, the same structural isolation as blog.mjs
// and voice.mjs — everything lives under pk = TENANT#{tenantId} where the
// tenantId is the Cognito sub from the authorizer, never the client.
//
//   Feed source   pk=TENANT#{tenantId}  sk=FEED#SOURCE#{feedId}
//
// Only the source list is persisted. Feed items are fetched live on demand
// (see services/rss.mjs) and never stored — the "feed" is a live aggregation,
// so it can't go stale and there's no backfill/expiry to manage. feedId is a
// ULID, so the sk is time-ordered (newest sources sort last); listFeedSources
// sorts to newest-first in code for a stable display order.

export function feedSourceKey(tenantId, feedId) {
  return { pk: tenantPartition(tenantId), sk: `FEED#SOURCE#${feedId}` };
}

const SOURCE_PREFIX = "FEED#SOURCE#";

// Creates a feed source. `url` is the feed URL (already validated as a public
// http(s) URL by the route); `title` is an optional creator-supplied label
// that overrides the feed's own <title> in the aggregate. Returns the row.
export async function createFeedSource(tenantId, { url, title } = {}) {
  const id = ulid();
  const now = new Date().toISOString();
  const item = {
    ...feedSourceKey(tenantId, id),
    entity: "FeedSource",
    tenantId,
    feedId: id,
    url,
    createdAt: now,
    updatedAt: now,
  };
  if (title) {
    item.title = title;
  }
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

// Every feed source for the tenant, newest-created first. A creator's feed
// list is a handful of sources (personal-scale), so paging the whole prefix
// and sorting in code is comfortably cheap.
export async function listFeedSources(tenantId) {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": tenantPartition(tenantId),
        ":prefix": SOURCE_PREFIX,
      },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const it of result.Items ?? []) items.push(it);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  items.sort((a, b) => String(b.feedId).localeCompare(String(a.feedId)));
  return items;
}

export async function getFeedSource(tenantId, feedId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: feedSourceKey(tenantId, feedId),
  }));
  return result.Item ?? null;
}

// Applies a partial update (title, muted) to a source. A null value clears the
// field. Throws NotFound when the source doesn't exist so PATCH is a clean 404
// rather than an upsert. Returns the updated row.
export async function updateFeedSource(tenantId, feedId, fields = {}) {
  const names = { "#updatedAt": "updatedAt" };
  const values = { ":updatedAt": new Date().toISOString() };
  const setClauses = ["#updatedAt = :updatedAt"];
  const removeClauses = [];

  for (const [key, value] of Object.entries(fields)) {
    const namePlaceholder = `#${key}`;
    names[namePlaceholder] = key;
    if (value === null) {
      removeClauses.push(namePlaceholder);
    } else {
      values[`:${key}`] = value;
      setClauses.push(`${namePlaceholder} = :${key}`);
    }
  }

  let updateExpression = `SET ${setClauses.join(", ")}`;
  if (removeClauses.length > 0) {
    updateExpression += ` REMOVE ${removeClauses.join(", ")}`;
  }

  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: feedSourceKey(tenantId, feedId),
      UpdateExpression: updateExpression,
      ConditionExpression: "attribute_exists(sk)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("FeedSource", feedId);
    }
    throw err;
  }
}

// Deletes a feed source. Throws NotFound when it doesn't exist so DELETE is a
// clean 404 rather than a no-op.
export async function deleteFeedSource(tenantId, feedId) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: feedSourceKey(tenantId, feedId),
      ConditionExpression: "attribute_exists(sk)",
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("FeedSource", feedId);
    }
    throw err;
  }
}

// Best-effort health stamp written after an aggregation fetch, so the UI can
// show which feeds are healthy and surface broken ones. `ok` flips
// lastStatus; `itemCount` and `error` are recorded for display. Conditional on
// existence so a source deleted mid-fetch isn't resurrected; a missing row (or
// any transient failure) is swallowed by the caller — health is advisory and
// must never fail the read it rides along with.
export async function recordFeedFetch(tenantId, feedId, { ok, itemCount, error } = {}) {
  const now = new Date().toISOString();
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: feedSourceKey(tenantId, feedId),
    UpdateExpression: ok
      ? "SET lastFetchedAt = :now, lastStatus = :ok, lastItemCount = :count REMOVE lastError"
      : "SET lastFetchedAt = :now, lastStatus = :err, lastError = :error",
    ConditionExpression: "attribute_exists(sk)",
    ExpressionAttributeValues: ok
      ? { ":now": now, ":ok": "ok", ":count": itemCount ?? 0 }
      : { ":now": now, ":err": "error", ":error": String(error ?? "unknown error").slice(0, 500) },
  }));
}
