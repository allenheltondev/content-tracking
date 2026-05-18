import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { respond } from "./utils/response.mjs";

const ddb = new DynamoDBClient();

const FANOUT_CONCURRENCY = parseInt(process.env.ANALYTICS_FANOUT_CONCURRENCY || "10", 10);

export const handler = async (event) => {
  const campaignId = event.pathParameters?.campaignId;
  if (!campaignId) {
    return respond(400, "campaignId path parameter is required");
  }

  const items = await queryPartition(`CAMPAIGN#${campaignId}`);
  const hasCampaign = items.some((it) => it.sk === "METADATA");
  if (!hasCampaign) {
    return respond(404, `Campaign ${campaignId} not found`);
  }

  const links = items.filter((it) => it.sk.startsWith("LINK#"));
  if (links.length === 0) {
    return respond(200, {
      campaign_id: campaignId,
      link_count: 0,
      total_clicks: 0,
      by_role: {},
      by_platform: {},
      links: [],
    });
  }

  const perLink = await runInBatches(
    links.map((link) => async () => {
      try {
        const analytics = await fetchAnalytics(link.code);
        return { link, analytics, error: null };
      } catch (err) {
        return { link, analytics: null, error: err.message };
      }
    }),
    FANOUT_CONCURRENCY
  );

  const failures = perLink.filter((r) => r.error);
  if (failures.length === links.length) {
    return respond(502, "All upstream analytics calls failed");
  }

  const rollup = aggregate(perLink);

  return respond(200, {
    campaign_id: campaignId,
    link_count: links.length,
    ...rollup,
    upstream_failures: failures.length,
    links: perLink.map(({ link, analytics, error }) => ({
      link_id: link.linkId,
      code: link.code,
      role: link.role,
      platform: link.platform,
      url: link.url,
      total_clicks: analytics?.total_clicks ?? 0,
      first_click_at: analytics?.first_click_at ?? null,
      last_click_at: analytics?.last_click_at ?? null,
      error,
    })),
  });
};

function aggregate(perLink) {
  let totalClicks = 0;
  const byRole = {};
  const byPlatform = {};

  for (const { link, analytics } of perLink) {
    if (!analytics) continue;
    const clicks = analytics.total_clicks ?? 0;
    totalClicks += clicks;
    byRole[link.role] = (byRole[link.role] || 0) + clicks;
    byPlatform[link.platform] = (byPlatform[link.platform] || 0) + clicks;
  }

  return { total_clicks: totalClicks, by_role: byRole, by_platform: byPlatform };
}

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

async function fetchAnalytics(code) {
  const response = await fetch(`${process.env.NEWSLETTER_API_BASE_URL}/links/${code}/analytics`, {
    method: "GET",
    headers: { "x-api-key": process.env.NEWSLETTER_MINT_API_KEY },
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`Analytics fetch failed: ${response.status} ${text}`);
    err.statusCode = response.status;
    throw err;
  }
  return JSON.parse(text);
}

async function runInBatches(ops, batchSize) {
  const results = [];
  for (let i = 0; i < ops.length; i += batchSize) {
    const batch = ops.slice(i, i + batchSize);
    const settled = await Promise.all(batch.map((fn) => fn()));
    results.push(...settled);
  }
  return results;
}
