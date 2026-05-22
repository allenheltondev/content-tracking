import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { respond } from "./utils/response.mjs";
import { formatPayout } from "./utils/payout.mjs";

const ddb = new DynamoDBClient();

export const handler = async (event) => {
  const campaignId = event.pathParameters?.campaignId;
  if (!campaignId) {
    return respond(400, "campaignId path parameter is required");
  }

  const items = await queryPartition(`CAMPAIGN#${campaignId}`);
  const metadata = items.find((it) => it.sk === "METADATA");
  if (!metadata) {
    return respond(404, `Campaign ${campaignId} not found`);
  }

  const links = items
    .filter((it) => it.sk.startsWith("LINK#"))
    .map(formatLink)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  return respond(200, {
    campaign: formatCampaign(metadata),
    links,
  });
};

async function queryPartition(pk) {
  const out = [];
  let lastEvaluatedKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: process.env.TABLE_NAME,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: marshall({ ":pk": pk }),
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    for (const item of result.Items || []) out.push(unmarshall(item));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return out;
}

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

function formatLink(row) {
  return {
    link_id: row.linkId,
    code: row.code,
    short_url: row.shortUrl,
    role: row.role,
    platform: row.platform,
    url: row.url,
    src: row.src ?? null,
    notes: row.notes ?? null,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
  };
}
