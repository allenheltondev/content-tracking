import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { TABLE_NAME, ddb, isConditionalCheckFailed } from "../services/ddb.mjs";
import { NotFoundError } from "../services/errors.mjs";
import { findCampaign, listActiveCampaigns, listCampaignsByStatus } from "./campaign.mjs";
import { listCampaignLinks } from "./link.mjs";

// SocialPost records:
//   pk = CAMPAIGN#{campaignId}, sk = SOCIALPOST#{postId}
// They sit under the campaign partition (like Links) so they ride along on
// the getCampaignWithLinks Query and never appear in any "list all" view.
// No GSI1 keys for the same reason.
//
// Daily engagement snapshots live alongside them under:
//   pk = CAMPAIGN#{campaignId}, sk = SOCIALPOST#{postId}#SNAPSHOT#{YYYY-MM-DD}
// Each PUT of analytics also writes (or overwrites) that day's snapshot so
// we can render per-day charts later. Same-day rewrites are intentional —
// only the last write of the day is kept.

function socialPostKey(campaignId, postId) {
  return { pk: `CAMPAIGN#${campaignId}`, sk: `SOCIALPOST#${postId}` };
}

function socialPostSnapshotKey(campaignId, postId, snapshotDate) {
  return { pk: `CAMPAIGN#${campaignId}`, sk: `SOCIALPOST#${postId}#SNAPSHOT#${snapshotDate}` };
}

function snapshotDateFrom(capturedAt) {
  const d = capturedAt ? new Date(capturedAt) : new Date();
  return d.toISOString().slice(0, 10);
}

export async function createSocialPost(campaignId, fields) {
  const campaign = await findCampaign(campaignId);
  if (!campaign) {
    throw new NotFoundError("Campaign", campaignId);
  }

  const postId = ulid();
  const createdAt = new Date().toISOString();
  const item = {
    ...socialPostKey(campaignId, postId),
    entity: "SocialPost",
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

export async function listSocialPosts(campaignId) {
  // begins_with(sk, "SOCIALPOST#") also matches per-day snapshot rows
  // (sk = SOCIALPOST#{postId}#SNAPSHOT#{date}), so filter to the post
  // entity to keep snapshots out of post listings.
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    FilterExpression: "#entity = :entity",
    ExpressionAttributeNames: { "#entity": "entity" },
    ExpressionAttributeValues: {
      ":pk": `CAMPAIGN#${campaignId}`,
      ":prefix": "SOCIALPOST#",
      ":entity": "SocialPost",
    },
  }));
  return result.Items ?? [];
}

export async function findSocialPost(campaignId, postId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: socialPostKey(campaignId, postId),
  }));
  return result.Item ?? null;
}

// Replaces the analytics map wholesale and stamps `lastFetched` with the
// server's clock — that's the authoritative "last time we pulled fresh
// numbers" value the dashboard surfaces. `capturedAt` (when the client
// observed the metrics) is stored alongside when supplied.
export async function updateSocialPostAnalytics(campaignId, postId, { metrics, capturedAt }) {
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
      Key: socialPostKey(campaignId, postId),
      UpdateExpression: `SET ${setClauses.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(sk)",
      ReturnValues: "ALL_NEW",
    }));
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new NotFoundError("SocialPost", postId);
    }
    throw err;
  }

  // Persist a per-day snapshot so the analytics UI can render daily series.
  // Same-day rewrites overwrite — only the last write of the day is kept.
  const snapshotDate = snapshotDateFrom(capturedAt);
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      ...socialPostSnapshotKey(campaignId, postId, snapshotDate),
      entity: "SocialPostSnapshot",
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

// Returns the day-by-day engagement snapshots for a single post, oldest
// first. Personal-scale data so all pages are consumed.
export async function listSocialPostSnapshots(campaignId, postId) {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `CAMPAIGN#${campaignId}`,
        ":prefix": `SOCIALPOST#${postId}#SNAPSHOT#`,
      },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const it of result.Items ?? []) items.push(it);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  items.sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
  return items;
}

export async function deleteSocialPost(campaignId, postId) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: socialPostKey(campaignId, postId),
      ConditionExpression: "attribute_exists(sk)",
    }));
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new NotFoundError("SocialPost", postId);
    }
    throw err;
  }
}

// Feed the Chrome extension polls: every social post belonging to a
// currently-active campaign. Fans out one Query per active campaign with
// bounded concurrency. Personal-scale data sets, so we consume every page.
const FANOUT_CONCURRENCY = 10;

export async function listActiveCampaignSocialPosts(tenantId) {
  const campaigns = await listActiveCampaigns(tenantId);
  const results = await runInBatches(
    campaigns.map((campaign) => async () => {
      const posts = await listSocialPosts(campaign.campaignId);
      return posts.map((post) => ({ campaign, post }));
    }),
    FANOUT_CONCURRENCY,
  );
  return results.flat();
}

// Working set the Chrome extension polls during the monitoring phase: every
// social post and every cross-post Link belonging to a campaign whose
// status is "monitoring". Returns posts and links pre-joined to their
// campaign so the extension has the campaign name for display without a
// second round trip.
export async function listMonitoringWorkingSet(tenantId) {
  const campaigns = await listCampaignsByStatus("monitoring", tenantId);
  const results = await runInBatches(
    campaigns.map((campaign) => async () => {
      const [posts, links] = await Promise.all([
        listSocialPosts(campaign.campaignId),
        listCampaignLinks(campaign.campaignId),
      ]);
      const crossPostLinks = links.filter((l) => l.role === "cross_post");
      return {
        campaign,
        posts: posts.map((post) => ({ campaign, post })),
        crossPostLinks: crossPostLinks.map((link) => ({ campaign, link })),
      };
    }),
    FANOUT_CONCURRENCY,
  );
  return {
    socialPosts: results.flatMap((r) => r.posts),
    crossPostLinks: results.flatMap((r) => r.crossPostLinks),
  };
}

async function runInBatches(ops, batchSize) {
  const out = [];
  for (let i = 0; i < ops.length; i += batchSize) {
    const settled = await Promise.all(ops.slice(i, i + batchSize).map((fn) => fn()));
    out.push(...settled);
  }
  return out;
}
