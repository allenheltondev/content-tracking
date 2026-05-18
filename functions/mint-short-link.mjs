import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore";
import { ulid } from "ulid";
import crypto from "crypto";

const ddb = new DynamoDBClient();
const kvs = new CloudFrontKeyValueStoreClient();

const TABLE = process.env.TABLE_NAME;
const KVS_ARN = process.env.KVS_ARN;
const SHORT_LINK_BASE = process.env.SHORT_LINK_BASE;

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const CODE_LENGTH = 6;
const MAX_COLLISION_RETRIES = 5;
const VALID_ROLES = new Set(["main", "cross_post", "social_promo"]);

export const handler = async (event) => {
  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
  } catch {
    return respond(400, { error: "invalid_json" });
  }

  const { campaign_id, url, role, platform, link_id: providedLinkId, src, notes } = body;

  if (!campaign_id || typeof campaign_id !== "string") {
    return respond(400, { error: "campaign_id required" });
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    return respond(400, { error: "valid http(s) url required" });
  }
  if (url.length > 2048) {
    return respond(400, { error: "url too long" });
  }
  if (role && !VALID_ROLES.has(role)) {
    return respond(400, { error: `role must be one of ${[...VALID_ROLES].join(", ")}` });
  }

  const finalRole = role || "main";
  const finalPlatform = platform || "unknown";
  const linkId = providedLinkId || ulid();
  const cid = `campaign#${campaign_id}#link#${linkId}`;
  const now = new Date().toISOString();

  const code = await allocateUniqueCode(campaign_id, linkId);
  if (!code) {
    return respond(503, { error: "could_not_allocate_code" });
  }

  await writeKvsEntry(code, { u: url, cid, src: src || null });

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall({
      pk: `CAMPAIGN#${campaign_id}`,
      sk: `LINK#${linkId}`,
      gsi1pk: `CODE#${code}`,
      gsi1sk: `CODE#${code}`,
      entity: "Link",
      campaignId: campaign_id,
      linkId,
      code,
      role: finalRole,
      platform: finalPlatform,
      url,
      defaultSrc: src || null,
      notes: notes || null,
      createdAt: now,
    }, { removeUndefinedValues: true }),
  }));

  return respond(200, {
    code,
    short_url: `${SHORT_LINK_BASE}/${code}`,
    campaign_id,
    link_id: linkId,
    role: finalRole,
    platform: finalPlatform,
    url,
  });
};

async function allocateUniqueCode(campaignId, linkId) {
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const code = generateCode();
    try {
      await ddb.send(new PutItemCommand({
        TableName: TABLE,
        Item: marshall({
          pk: `CODE#${code}`,
          sk: `CODE#${code}`,
          entity: "ShortCode",
          campaignId,
          linkId,
          createdAt: new Date().toISOString(),
        }),
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      return code;
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        continue;
      }
      throw err;
    }
  }
  return null;
}

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

async function writeKvsEntry(code, value) {
  const describe = await kvs.send(new DescribeKeyValueStoreCommand({ KvsARN: KVS_ARN }));
  await kvs.send(new PutKeyCommand({
    KvsARN: KVS_ARN,
    Key: code,
    Value: JSON.stringify(value),
    IfMatch: describe.ETag,
  }));
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
