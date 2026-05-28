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
import { findCampaign, listCampaignsByStatus } from "./campaign.mjs";

// ContentPost records:
//   pk = CAMPAIGN#{campaignId}, sk = CONTENTPOST#{postId}
// Same partition as SocialPost so both ride along on the campaign Query.
// Distinct sk prefix keeps the two buckets independently filterable so
// sponsor reports can render social and content engagement separately.
//
// Daily engagement snapshots live alongside them at:
//   pk = CAMPAIGN#{campaignId}, sk = CONTENTPOST#{postId}#SNAPSHOT#{YYYY-MM-DD}
// Each PUT of analytics also writes (or overwrites) that day's snapshot so
// the dashboard can chart day-by-day. Same-day rewrites are intentional —
// only the last write of the day is kept.

function contentPostKey(campaignId, postId) {
  return { pk: `CAMPAIGN#${campaignId}`, sk: `CONTENTPOST#${postId}` };
}

function contentPostSnapshotKey(campaignId, postId, snapshotDate) {
  return { pk: `CAMPAIGN#${campaignId}`, sk: `CONTENTPOST#${postId}#SNAPSHOT#${snapshotDate}` };
}

function snapshotDateFrom(capturedAt) {
  const d = capturedAt ? new Date(capturedAt) : new Date();
  return d.toISOString().slice(0, 10);
}

export async function createContentPost(campaignId, fields) {
  const campaign = await findCampaign(campaignId);
  if (!campaign) {
    throw new NotFoundError("Campaign", campaignId);
  }

  const postId = ulid();
  const createdAt = new Date().toISOString();
  const item = {
    ...contentPostKey(campaignId, postId),
    entity: "ContentPost",
    campaignId,
    postId,
    platform: fields.platform,
    url: fields.url,
    createdAt,
  };
  if (fields.notes) item.notes = fields.notes;

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
    ConditionExpression: "attribute_not_exists(sk)",
  }));

  return item;
}

export async function listContentPosts(campaignId) {
  // begins_with(sk, "CONTENTPOST#") also matches per-day snapshot rows
  // (sk = CONTENTPOST#{postId}#SNAPSHOT#{date}), so filter to the post
  // entity to keep snapshots out of post listings.
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    FilterExpression: "#entity = :entity",
    ExpressionAttributeNames: { "#entity": "entity" },
    ExpressionAttributeValues: {
      ":pk": `CAMPAIGN#${campaignId}`,
      ":prefix": "CONTENTPOST#",
      ":entity": "ContentPost",
    },
  }));
  return result.Items ?? [];
}

export async function findContentPost(campaignId, postId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: contentPostKey(campaignId, postId),
  }));
  return result.Item ?? null;
}

// Replaces the analytics map wholesale and stamps `lastFetched` with the
// server's clock. `capturedAt` (when the client observed the metrics) is
// stored alongside when supplied, and seeds the snapshot date.
export async function updateContentPostAnalytics(campaignId, postId, { metrics, capturedAt }) {
  const now = new Date().toISOString();
  const names = {
    "#analytics": "analytics",
    "#lastFetched": "lastFetched",
    "#updatedAt": "updatedAt",
  };
  const values = {
    ":analytics": metrics,
    ":lastFetched": now,
    ":updatedAt": now,
  };
  const setClauses = [
    "#analytics = :analytics",
    "#lastFetched = :lastFetched",
    "#updatedAt = :updatedAt",
  ];
  if (capturedAt !== undefined) {
    names["#capturedAt"] = "capturedAt";
    values[":capturedAt"] = capturedAt;
    setClauses.push("#capturedAt = :capturedAt");
  }

  let result;
  try {
    result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: contentPostKey(campaignId, postId),
      UpdateExpression: `SET ${setClauses.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(sk)",
      ReturnValues: "ALL_NEW",
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("ContentPost", postId);
    }
    throw err;
  }

  // Same-day rewrites overwrite — only the last write of the day is kept.
  const snapshotDate = snapshotDateFrom(capturedAt);
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...contentPostSnapshotKey(campaignId, postId, snapshotDate),
      entity: "ContentPostSnapshot",
      campaignId,
      postId,
      snapshotDate,
      metrics,
      capturedAt: capturedAt ?? now,
      recordedAt: now,
    },
  }));

  return result.Attributes;
}

// Day-by-day engagement snapshots for a single content post, oldest first.
// Personal-scale data so all pages are consumed.
export async function listContentPostSnapshots(campaignId, postId) {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `CAMPAIGN#${campaignId}`,
        ":prefix": `CONTENTPOST#${postId}#SNAPSHOT#`,
      },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const it of result.Items ?? []) items.push(it);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  items.sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
  return items;
}

export async function deleteContentPost(campaignId, postId) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: contentPostKey(campaignId, postId),
      ConditionExpression: "attribute_exists(sk)",
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("ContentPost", postId);
    }
    throw err;
  }
}

// Monitoring-phase content-post working set: every content post belonging
// to a campaign whose status is "monitoring", pre-joined to its campaign.
// Mirrors listMonitoringWorkingSet in social-post.mjs so the extension can
// fetch all three feeds (social, content, cross-post links) via a single
// /monitoring/working-set call.
const FANOUT_CONCURRENCY = 10;

export async function listMonitoringContentPosts() {
  const campaigns = await listCampaignsByStatus("monitoring");
  const results = await runInBatches(
    campaigns.map((campaign) => async () => {
      const posts = await listContentPosts(campaign.campaignId);
      return posts.map((post) => ({ campaign, post }));
    }),
    FANOUT_CONCURRENCY,
  );
  return results.flat();
}

async function runInBatches(ops, batchSize) {
  const out = [];
  for (let i = 0; i < ops.length; i += batchSize) {
    const settled = await Promise.all(ops.slice(i, i + batchSize).map((fn) => fn()));
    out.push(...settled);
  }
  return out;
}
