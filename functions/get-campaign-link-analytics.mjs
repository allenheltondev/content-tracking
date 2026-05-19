import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { respond } from "./utils/response.mjs";

const ddb = new DynamoDBClient();

export const handler = async (event) => {
  const campaignId = event.pathParameters?.campaignId;
  const linkId = event.pathParameters?.linkId;
  if (!campaignId || !linkId) {
    return respond(400, "campaignId and linkId path parameters are required");
  }

  const link = await getLink(campaignId, linkId);
  if (!link) {
    return respond(404, `Link ${linkId} not found in campaign ${campaignId}`);
  }

  let analytics;
  try {
    analytics = await fetchAnalytics(link.code);
  } catch (err) {
    console.error("Analytics upstream call failed", { campaignId, linkId, code: link.code, error: err.message });
    return respond(502, "Upstream analytics service unavailable");
  }

  return respond(200, {
    campaign_id: campaignId,
    link_id: linkId,
    code: link.code,
    role: link.role,
    platform: link.platform,
    url: link.url,
    analytics,
  });
};

async function getLink(campaignId, linkId) {
  const result = await ddb.send(new GetItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: marshall({ pk: `CAMPAIGN#${campaignId}`, sk: `LINK#${linkId}` }),
  }));
  return result.Item ? unmarshall(result.Item) : null;
}

async function fetchAnalytics(code) {
  const response = await fetch(`${process.env.NEWSLETTER_API_BASE_URL}/links/${code}/analytics`, {
    method: "GET",
    headers: { "Authorization": process.env.NEWSLETTER_MINT_API_KEY },
  });

  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`Analytics fetch failed: ${response.status}`);
    err.statusCode = response.status;
    err.body = text;
    throw err;
  }
  return JSON.parse(text);
}
