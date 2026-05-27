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
import { findCampaign, listActiveCampaigns } from "./campaign.mjs";

// SocialPost records:
//   pk = CAMPAIGN#{campaignId}, sk = SOCIALPOST#{postId}
// They sit under the campaign partition (like Links) so they ride along on
// the getCampaignWithLinks Query and never appear in any "list all" view.
// No GSI1 keys for the same reason.

function socialPostKey(campaignId, postId) {
  return { pk: `CAMPAIGN#${campaignId}`, sk: `SOCIALPOST#${postId}` };
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
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": `CAMPAIGN#${campaignId}`,
      ":prefix": "SOCIALPOST#",
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

  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: socialPostKey(campaignId, postId),
      UpdateExpression: `SET ${setClauses.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(sk)",
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("SocialPost", postId);
    }
    throw err;
  }
}

export async function deleteSocialPost(campaignId, postId) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: socialPostKey(campaignId, postId),
      ConditionExpression: "attribute_exists(sk)",
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("SocialPost", postId);
    }
    throw err;
  }
}

// Feed the Chrome extension polls: every social post belonging to a
// currently-active campaign. Fans out one Query per active campaign with
// bounded concurrency. Personal-scale data sets, so we consume every page.
const FANOUT_CONCURRENCY = 10;

export async function listActiveCampaignSocialPosts() {
  const campaigns = await listActiveCampaigns();
  const results = await runInBatches(
    campaigns.map((campaign) => async () => {
      const posts = await listSocialPosts(campaign.campaignId);
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
