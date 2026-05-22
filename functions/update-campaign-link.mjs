import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { respond } from "./utils/response.mjs";

const ddb = new DynamoDBClient();

// Whitelist of editable Link fields. Maps the snake_case API field to the
// camelCase DynamoDB attribute name. Anything outside this set is either an
// immutable identifier (code, short_url, url, role, platform, link_id,
// campaign_id) or a derived/internal attribute the caller shouldn't touch.
const EDITABLE_FIELDS = {
  notes: "notes",
  src: "src",
  expires_at: "expiresAt",
};

// Block both the canonical (API) names and the underlying DDB attribute names
// so a caller can't sneak through by spelling "shortUrl" instead of "short_url".
// expires_at is the editable equivalent of expiresAt, so it stays out of here.
const IMMUTABLE_FIELDS = new Set([
  "campaign_id",
  "link_id",
  "code",
  "short_url",
  "url",
  "role",
  "platform",
  "created_at",
  "createdAt",
  "campaignId",
  "linkId",
  "shortUrl",
]);

export const handler = async (event) => {
  const campaignId = event.pathParameters?.campaignId;
  const linkId = event.pathParameters?.linkId;
  if (!campaignId || !linkId) {
    return respond(400, "campaignId and linkId path parameters are required");
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

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return respond(400, "Body must be a JSON object");
  }

  if (Object.keys(body).length === 0) {
    return respond(400, "request body must contain at least one updatable field");
  }

  // Reject any attempt to write an immutable field, even via the alternate
  // (camelCase) attribute name. We want a loud 400 rather than silently
  // dropping the field so callers don't think the change took.
  for (const key of Object.keys(body)) {
    if (IMMUTABLE_FIELDS.has(key)) {
      return respond(400, `Field "${key}" is immutable and cannot be updated`);
    }
    if (!Object.prototype.hasOwnProperty.call(EDITABLE_FIELDS, key)) {
      return respond(400, `Field "${key}" is not editable`);
    }
  }

  const validation = validateFields(body);
  if (validation) return validation;

  const setClauses = [];
  const removeClauses = [];
  const names = { "#updatedAt": "updatedAt" };
  const values = { ":updatedAt": new Date().toISOString() };

  for (const [apiKey, value] of Object.entries(body)) {
    const attr = EDITABLE_FIELDS[apiKey];
    const placeholder = `#${attr}`;
    names[placeholder] = attr;
    if (value === null) {
      removeClauses.push(placeholder);
    } else {
      const valuePlaceholder = `:${attr}`;
      values[valuePlaceholder] = value;
      setClauses.push(`${placeholder} = ${valuePlaceholder}`);
    }
  }

  setClauses.push("#updatedAt = :updatedAt");

  let updateExpression = `SET ${setClauses.join(", ")}`;
  if (removeClauses.length > 0) {
    updateExpression += ` REMOVE ${removeClauses.join(", ")}`;
  }

  let result;
  try {
    result = await ddb.send(new UpdateItemCommand({
      TableName: process.env.TABLE_NAME,
      Key: marshall({ pk: `CAMPAIGN#${campaignId}`, sk: `LINK#${linkId}` }),
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
      ConditionExpression: "attribute_exists(pk)",
      ReturnValues: "ALL_NEW",
    }));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return respond(404, `Link ${linkId} not found in campaign ${campaignId}`);
    }
    throw err;
  }

  return respond(200, formatLink(unmarshall(result.Attributes)));
};

function validateFields(body) {
  if (Object.prototype.hasOwnProperty.call(body, "notes")) {
    const v = body.notes;
    if (v !== null && (typeof v !== "string" || v.length > 1000)) {
      return respond(400, "notes must be a string up to 1000 chars or null");
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "src")) {
    const v = body.src;
    if (v !== null && (typeof v !== "string" || v.length === 0 || v.length > 64)) {
      return respond(400, "src must be a non-empty string up to 64 chars or null");
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "expires_at")) {
    const v = body.expires_at;
    if (v !== null) {
      if (typeof v !== "string") {
        return respond(400, "expires_at must be an ISO 8601 date-time string or null");
      }
      const parsed = Date.parse(v);
      if (Number.isNaN(parsed)) {
        return respond(400, "expires_at must be a valid ISO 8601 date-time string");
      }
    }
  }
  return null;
}

function formatLink(row) {
  return {
    campaign_id: row.campaignId,
    link_id: row.linkId,
    code: row.code,
    short_url: row.shortUrl,
    role: row.role,
    platform: row.platform,
    url: row.url,
    src: row.src ?? null,
    notes: row.notes ?? null,
    expires_at: row.expiresAt ?? null,
    created_at: row.createdAt,
  };
}
