import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_NAME, ddb, isConditionalCheckFailed } from "../services/ddb.mjs";
import { NotFoundError } from "../services/errors.mjs";
import { findCampaign } from "./campaign.mjs";

// A draft belongs to exactly one campaign and lives under the campaign's
// partition:
//   pk = CAMPAIGN#{campaignId}, sk = DRAFT
//
// At most one per campaign, so saving a new link replaces the prior draft
// (and clears any stale review — the link now points at different
// content). It rides along on the GET /campaigns/{id} Query (same pk).

function draftKey(campaignId) {
  return { pk: `CAMPAIGN#${campaignId}`, sk: "DRAFT" };
}

export async function saveDraftForCampaign({ campaignId, url, docId }) {
  // Pre-check the campaign exists so we never orphan a draft under a
  // campaign that was never created. A clean 404 beats a silent write.
  const campaign = await findCampaign(campaignId);
  if (!campaign) {
    throw new NotFoundError("Campaign", campaignId);
  }

  const now = new Date().toISOString();
  const item = {
    ...draftKey(campaignId),
    entity: "Draft",
    campaignId,
    url,
    docId: docId ?? null,
    review: null,
    reviewedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  // No attribute_not_exists condition: a fresh save intentionally replaces
  // the campaign's previous draft and resets the review.
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

export async function getDraftForCampaign(campaignId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: draftKey(campaignId),
  }));
  return result.Item ?? null;
}

// Stores the AI review onto the existing draft. Conditional on the draft
// existing so a review can't resurrect a deleted/never-saved draft.
export async function saveDraftReview(campaignId, review) {
  const now = new Date().toISOString();
  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: draftKey(campaignId),
      UpdateExpression: "SET #review = :review, reviewedAt = :now, updatedAt = :now",
      ExpressionAttributeNames: { "#review": "review" },
      ExpressionAttributeValues: { ":review": review, ":now": now },
      ConditionExpression: "attribute_exists(sk)",
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new NotFoundError("Draft", campaignId);
    }
    throw err;
  }
}
