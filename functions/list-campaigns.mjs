import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { respond } from "./utils/response.mjs";
import { formatPayout } from "./utils/payout.mjs";

const ddb = new DynamoDBClient();

const VALID_STATUSES = new Set(["draft", "active", "completed"]);
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Personal-scale tool with low campaign cardinality — Scan with a filter is
// fine here. If this ever needs a GSI, switch the filter for a Query
// against an EntityIndex (`entity` partition). Mirrors list-vendors.mjs.
export const handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const limitRaw = qs.limit;
  const startKeyRaw = qs.startKey;
  const vendorIdRaw = qs.vendorId;
  const statusRaw = qs.status;

  let limit = 100;
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
      return respond(400, "limit must be an integer between 1 and 500");
    }
    limit = parsed;
  }

  let exclusiveStartKey;
  if (startKeyRaw) {
    try {
      exclusiveStartKey = JSON.parse(Buffer.from(startKeyRaw, "base64").toString("utf8"));
    } catch {
      return respond(400, "startKey is not a valid base64-encoded JSON pagination token");
    }
  }

  if (vendorIdRaw !== undefined && !ULID_RE.test(vendorIdRaw)) {
    return respond(400, "vendorId must be a ULID");
  }

  if (statusRaw !== undefined && !VALID_STATUSES.has(statusRaw)) {
    return respond(400, `status must be one of ${[...VALID_STATUSES].join(", ")}`);
  }

  // Build the filter expression dynamically. `status` is a DynamoDB reserved
  // word so it needs a name placeholder.
  const filterParts = ["#entity = :v AND #sk = :metadata"];
  const names = { "#entity": "entity", "#sk": "sk" };
  const values = { ":v": "Campaign", ":metadata": "METADATA" };

  if (vendorIdRaw) {
    filterParts.push("vendorId = :vendorId");
    values[":vendorId"] = vendorIdRaw;
  }
  if (statusRaw) {
    filterParts.push("#status = :status");
    names["#status"] = "status";
    values[":status"] = statusRaw;
  }

  // FilterExpression is applied AFTER Limit, so a single Scan can return
  // fewer rows than requested even when more matching rows remain. Loop
  // until we fill the page or DynamoDB signals no more pages.
  const collected = [];
  let lastEvaluatedKey = exclusiveStartKey;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: process.env.TABLE_NAME,
      FilterExpression: filterParts.join(" AND "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
      Limit: limit,
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    for (const item of result.Items || []) {
      collected.push(unmarshall(item));
      if (collected.length >= limit) break;
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey && collected.length < limit);

  const campaigns = collected
    .map(formatCampaign)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const nextStartKey = lastEvaluatedKey
    ? Buffer.from(JSON.stringify(lastEvaluatedKey)).toString("base64")
    : null;

  return respond(200, { campaigns, nextStartKey });
};

function formatCampaign(row) {
  return {
    campaign_id: row.campaignId,
    name: row.name,
    sponsor: row.sponsor ?? null,
    vendor_id: row.vendorId ?? null,
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
    status: row.status,
    targetMetrics: row.targetMetrics ?? null,
    payout: formatPayout(row.payout),
    created_at: row.createdAt,
  };
}
