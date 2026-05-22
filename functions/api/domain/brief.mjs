import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
import { NotFoundError } from "../services/errors.mjs";

// Brief records live at:
//   pk = BRIEF#{briefId}, sk = METADATA   — the summary + suggested campaign
//   pk = BRIEF#{briefId}, sk = CAMPAIGN#{campaignId}
//                                        — written when ?createDraft=true
//                                          creates a Campaign from the brief
//
// They also write GSI1 so a future GET /briefs (list) endpoint can be a
// Query, not a Scan:
//   gsi1pk = "BRIEFS"
//   gsi1sk = "{createdAt}#{briefId}"

const BRIEFS_PARTITION = "BRIEFS";

export function newBriefId() {
  return ulid();
}

export async function createBriefRecord({
  briefId,
  sourceType,
  s3Key,
  summary,
  suggestedCampaign,
  warnings,
  campaignDraft, // optional Campaign metadata to write transactionally
}) {
  const now = new Date().toISOString();

  const briefItem = {
    pk: `BRIEF#${briefId}`,
    sk: "METADATA",
    entity: "Brief",
    briefId,
    sourceType,
    s3Key,
    summary,
    suggestedCampaign,
    warnings: warnings ?? [],
    gsi1pk: BRIEFS_PARTITION,
    gsi1sk: `${now}#${briefId}`,
    createdAt: now,
  };

  const transactItems = [{
    Put: {
      TableName: TABLE_NAME,
      Item: briefItem,
      ConditionExpression: "attribute_not_exists(pk)",
    },
  }];

  if (campaignDraft) {
    // Campaign metadata + the brief-to-campaign link, all in one transaction
    // so we never end up with a brief that thinks it created a campaign
    // that doesn't exist (or vice versa).
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: campaignDraft,
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: {
          pk: `BRIEF#${briefId}`,
          sk: `CAMPAIGN#${campaignDraft.campaignId}`,
          entity: "CampaignByBrief",
          briefId,
          campaignId: campaignDraft.campaignId,
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
  }

  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  return briefItem;
}

export async function getBriefWithCampaign(briefId) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": `BRIEF#${briefId}` },
  }));
  const items = result.Items ?? [];
  const metadata = items.find((it) => it.sk === "METADATA");
  if (!metadata) {
    throw new NotFoundError("Brief", briefId);
  }
  const campaignLink = items.find(
    (it) => typeof it.sk === "string" && it.sk.startsWith("CAMPAIGN#"),
  );
  return { metadata, campaignId: campaignLink?.campaignId ?? null };
}

// Used by POST /briefs after Bedrock returns the summary. Writes the
// brief without a campaign draft (createDraft=false case).
export async function persistBriefSummary({ briefId, sourceType, s3Key, summary, suggestedCampaign, warnings }) {
  return createBriefRecord({
    briefId,
    sourceType,
    s3Key,
    summary,
    suggestedCampaign,
    warnings,
  });
}

// Used by GET /briefs/{briefId} when no campaign is linked.
export async function getBrief(briefId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `BRIEF#${briefId}`, sk: "METADATA" },
  }));
  if (!result.Item) {
    throw new NotFoundError("Brief", briefId);
  }
  return result.Item;
}
