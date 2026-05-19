import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { ulid } from "ulid";
import { respond } from "./utils/response.mjs";

const ddb = new DynamoDBClient();

const VALID_STATUSES = new Set(["draft", "active", "completed"]);

export const handler = async (event) => {
  if (!event.body) {
    return respond(400, "Missing request body");
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, "Invalid JSON body");
  }

  const { name, sponsor, startDate, endDate, status, targetMetrics } = body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return respond(400, "name is required");
  }
  if (name.length > 200) {
    return respond(400, "name exceeds 200 chars");
  }
  if (sponsor !== undefined && (typeof sponsor !== "string" || sponsor.length > 200)) {
    return respond(400, "sponsor must be a string up to 200 chars");
  }
  if (status !== undefined && !VALID_STATUSES.has(status)) {
    return respond(400, `status must be one of ${[...VALID_STATUSES].join(", ")}`);
  }
  if (startDate !== undefined && !isIsoDate(startDate)) {
    return respond(400, "startDate must be YYYY-MM-DD");
  }
  if (endDate !== undefined && !isIsoDate(endDate)) {
    return respond(400, "endDate must be YYYY-MM-DD");
  }
  if (targetMetrics !== undefined && (typeof targetMetrics !== "object" || Array.isArray(targetMetrics) || targetMetrics === null)) {
    return respond(400, "targetMetrics must be an object");
  }

  const campaignId = ulid();
  const createdAt = new Date().toISOString();
  const finalStatus = status || "active";

  const item = {
    pk: `CAMPAIGN#${campaignId}`,
    sk: "METADATA",
    entity: "Campaign",
    campaignId,
    name: name.trim(),
    status: finalStatus,
    createdAt,
  };
  if (sponsor) item.sponsor = sponsor;
  if (startDate) item.startDate = startDate;
  if (endDate) item.endDate = endDate;
  if (targetMetrics) item.targetMetrics = targetMetrics;

  await ddb.send(new PutItemCommand({
    TableName: process.env.TABLE_NAME,
    Item: marshall(item, { removeUndefinedValues: true }),
    ConditionExpression: "attribute_not_exists(pk)",
  }));

  return respond(201, {
    campaign_id: campaignId,
    name: item.name,
    sponsor: item.sponsor ?? null,
    startDate: item.startDate ?? null,
    endDate: item.endDate ?? null,
    status: finalStatus,
    targetMetrics: item.targetMetrics ?? null,
    created_at: createdAt,
  });
};

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
