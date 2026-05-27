import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
import { NotFoundError } from "../services/errors.mjs";
import { findCampaign } from "./campaign.mjs";
import {
  mintShortLink,
  unmintShortLink,
} from "../services/newsletter-service.mjs";

// Link records:
//   pk = CAMPAIGN#{campaignId}, sk = LINK#{linkId}
// No GSI1 keys; they shouldn't appear in any "list all" view. They're
// queried via the campaign's partition (which already happens in
// getCampaignWithLinks).

function linkKey(campaignId, linkId) {
  return { pk: `CAMPAIGN#${campaignId}`, sk: `LINK#${linkId}` };
}

export async function createLink(campaignId, fields) {
  const campaign = await findCampaign(campaignId);
  if (!campaign) {
    throw new NotFoundError("Campaign", campaignId);
  }

  const mint = await mintShortLink({
    url: fields.url,
    src: fields.src,
    expiresInDays: fields.expiresInDays,
    campaignId: campaign.linkTrackingId,
  });

  const linkId = ulid();
  const createdAt = new Date().toISOString();
  const item = {
    ...linkKey(campaignId, linkId),
    entity: "Link",
    campaignId,
    linkId,
    code: mint.code,
    shortUrl: mint.short_url,
    role: fields.role,
    platform: fields.platform,
    url: fields.url,
    expiresAt: mint.expires_at,
    createdAt,
  };
  if (fields.src) item.src = fields.src;
  if (fields.notes) item.notes = fields.notes;

  // Registering a "main" role link is how users mark their primary
  // published URL. Adopt it as the campaign's blog_url when the campaign
  // doesn't have one yet, so the Overview, GA4 lookup, and Core Web
  // Vitals fetch all start working off that link without a second edit.
  const shouldAdoptBlogUrl = fields.role === "main" && !campaign.blogUrl;
  if (shouldAdoptBlogUrl) {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: item,
            ConditionExpression: "attribute_not_exists(sk)",
          },
        },
        {
          Update: {
            TableName: TABLE_NAME,
            Key: { pk: `CAMPAIGN#${campaignId}`, sk: "METADATA" },
            UpdateExpression: "SET #blogUrl = :blogUrl",
            ExpressionAttributeNames: { "#blogUrl": "blogUrl" },
            ExpressionAttributeValues: { ":blogUrl": fields.url },
            ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#blogUrl)",
          },
        },
      ],
    }));
    return item;
  }

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
    ConditionExpression: "attribute_not_exists(sk)",
  }));

  return item;
}

export async function getLink(campaignId, linkId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: linkKey(campaignId, linkId),
  }));
  if (!result.Item) {
    throw new NotFoundError("Link", linkId);
  }
  return result.Item;
}

// Returns the link without throwing. Used by routes that need to read
// before they decide what to do (e.g. delete needs `code` to unmint).
export async function findLink(campaignId, linkId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: linkKey(campaignId, linkId),
  }));
  return result.Item ?? null;
}

export async function updateLink(campaignId, linkId, fields) {
  const setClauses = [];
  const removeClauses = [];
  const names = { "#updatedAt": "updatedAt" };
  const values = { ":updatedAt": new Date().toISOString() };

  for (const [key, value] of Object.entries(fields)) {
    const namePlaceholder = `#${key}`;
    names[namePlaceholder] = key;
    if (value === null) {
      removeClauses.push(namePlaceholder);
    } else {
      const valuePlaceholder = `:${key}`;
      values[valuePlaceholder] = value;
      setClauses.push(`${namePlaceholder} = ${valuePlaceholder}`);
    }
  }
  setClauses.push("#updatedAt = :updatedAt");

  let updateExpression = `SET ${setClauses.join(", ")}`;
  if (removeClauses.length > 0) {
    updateExpression += ` REMOVE ${removeClauses.join(", ")}`;
  }

  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: linkKey(campaignId, linkId),
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(sk)",
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("Link", linkId);
    }
    throw err;
  }
}

export async function deleteLink(campaignId, linkId) {
  // Find first so we have the `code` to call newsletter-service.
  // Returning 404 here avoids hitting the upstream for non-existent
  // links.
  const link = await findLink(campaignId, linkId);
  if (!link) {
    throw new NotFoundError("Link", linkId);
  }

  // Upstream delete first. If it returns anything other than success or
  // already-gone, we throw and the local record stays — the two stores
  // are reconciled by the next deploy / manual retry.
  await unmintShortLink(link.code);

  await ddb.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: linkKey(campaignId, linkId),
  }));

  return link;
}
