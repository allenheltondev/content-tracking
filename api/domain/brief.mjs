import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
import { NotFoundError } from "../services/errors.mjs";
import { findCampaign } from "./campaign.mjs";

// A brief belongs to exactly one campaign and lives under the campaign's
// partition:
//   pk = CAMPAIGN#{campaignId}, sk = BRIEF
//
// There's at most one per campaign, so re-uploading replaces the prior
// brief. It rides along on the GET /campaigns/{id} Query (same pk) — no
// separate partition or GSI needed.

export async function saveBriefForCampaign({
  campaignId,
  sourceType,
  s3Key,
  summary,
  suggestedCampaign,
  warnings,
}) {
  // Pre-check the campaign exists so we never orphan a brief under a
  // campaign that was never created. A clean 404 beats a silent write.
  const campaign = await findCampaign(campaignId);
  if (!campaign) {
    throw new NotFoundError("Campaign", campaignId);
  }

  const now = new Date().toISOString();
  const item = {
    pk: `CAMPAIGN#${campaignId}`,
    sk: "BRIEF",
    entity: "Brief",
    campaignId,
    sourceType,
    s3Key,
    summary,
    suggestedCampaign,
    warnings: warnings ?? [],
    createdAt: now,
  };

  // No attribute_not_exists condition: a fresh upload intentionally
  // replaces the campaign's previous brief.
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
}

export async function getBriefForCampaign(campaignId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `CAMPAIGN#${campaignId}`, sk: "BRIEF" },
  }));
  return result.Item ?? null;
}
