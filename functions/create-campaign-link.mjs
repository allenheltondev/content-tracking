import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { ulid } from "ulid";
import { respond } from "./utils/response.mjs";

const ddb = new DynamoDBClient();

const VALID_ROLES = new Set(["main", "cross_post", "social_promo"]);

export const handler = async (event) => {
  const campaignId = event.pathParameters?.campaignId;
  if (!campaignId) {
    return respond(400, "campaignId path parameter is required");
  }

  if (!event.body) {
    return respond(400, "Missing request body");
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, "Invalid JSON body");
  }

  const { role, platform, url, src, notes, expiresInDays } = body;

  const validation = validateLinkInput({ role, platform, url, src, notes, expiresInDays });
  if (validation) return validation;

  const campaign = await getCampaign(campaignId);
  if (!campaign) {
    return respond(404, `Campaign ${campaignId} not found`);
  }

  const linkId = ulid();

  let mintResponse;
  try {
    mintResponse = await mintShortLink({ url, src, expiresInDays });
  } catch (err) {
    console.error("Mint upstream call failed", { campaignId, linkId, error: err.message });
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return respond(502, `Upstream mint rejected request: ${err.body}`);
    }
    return respond(502, "Upstream mint service unavailable");
  }

  const createdAt = new Date().toISOString();
  const linkItem = {
    pk: `CAMPAIGN#${campaignId}`,
    sk: `LINK#${linkId}`,
    entity: "Link",
    campaignId,
    linkId,
    code: mintResponse.code,
    shortUrl: mintResponse.short_url,
    role,
    platform,
    url,
    expiresAt: mintResponse.expires_at,
    createdAt,
  };
  if (src) linkItem.src = src;
  if (notes) linkItem.notes = notes;

  await ddb.send(new PutItemCommand({
    TableName: process.env.TABLE_NAME,
    Item: marshall(linkItem, { removeUndefinedValues: true }),
    ConditionExpression: "attribute_not_exists(sk)",
  }));

  return respond(201, {
    campaign_id: campaignId,
    link_id: linkId,
    code: mintResponse.code,
    short_url: mintResponse.short_url,
    role,
    platform,
    url,
    src: src ?? null,
    notes: notes ?? null,
    expires_at: mintResponse.expires_at,
    created_at: createdAt,
  });
};

function validateLinkInput({ role, platform, url, src, notes, expiresInDays }) {
  if (!role || !VALID_ROLES.has(role)) {
    return respond(400, `role must be one of ${[...VALID_ROLES].join(", ")}`);
  }
  if (!platform || typeof platform !== "string" || platform.length === 0 || platform.length > 64) {
    return respond(400, "platform is required (1-64 chars)");
  }
  if (!url || typeof url !== "string") {
    return respond(400, "url is required");
  }
  if (!/^https?:\/\//i.test(url)) {
    return respond(400, "url must be http or https");
  }
  if (url.length > 2048) {
    return respond(400, "url exceeds 2048 chars");
  }
  if (src !== undefined && (typeof src !== "string" || src.length > 64)) {
    return respond(400, "src must be a string up to 64 chars");
  }
  if (notes !== undefined && (typeof notes !== "string" || notes.length > 1000)) {
    return respond(400, "notes must be a string up to 1000 chars");
  }
  if (expiresInDays !== undefined) {
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 1825) {
      return respond(400, "expiresInDays must be an integer between 1 and 1825");
    }
  }
  return null;
}

async function getCampaign(campaignId) {
  const result = await ddb.send(new GetItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: marshall({ pk: `CAMPAIGN#${campaignId}`, sk: "METADATA" }),
  }));
  return result.Item ? unmarshall(result.Item) : null;
}

async function mintShortLink({ url, src, expiresInDays }) {
  const reqBody = { url };
  if (src) reqBody.src = src;
  if (expiresInDays !== undefined) reqBody.expiresInDays = expiresInDays;

  const response = await fetch(`${process.env.NEWSLETTER_API_BASE_URL}/links`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.NEWSLETTER_MINT_API_KEY,
    },
    body: JSON.stringify(reqBody),
  });

  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`Mint failed: ${response.status}`);
    err.statusCode = response.status;
    err.body = text;
    throw err;
  }

  return JSON.parse(text);
}
