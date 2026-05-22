import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { respond, empty } from "./utils/response.mjs";

const ddb = new DynamoDBClient();

export const handler = async (event) => {
  const campaignId = event.pathParameters?.campaignId;
  const linkId = event.pathParameters?.linkId;
  if (!campaignId || !linkId) {
    return respond(400, "campaignId and linkId path parameters are required");
  }

  // GetItem first so we can read the `code` newsletter-service needs and so
  // a missing link returns 404 without touching the upstream service.
  const link = await getLink(campaignId, linkId);
  if (!link) {
    return respond(404, `Link ${linkId} not found in campaign ${campaignId}`);
  }

  try {
    await unmintShortLink(link.code);
  } catch (err) {
    console.error("Unmint upstream call failed", { campaignId, linkId, code: link.code, error: err.message });
    if (err.statusCode && err.statusCode >= 400) {
      return respond(502, `Upstream link service rejected delete: ${err.body}`);
    }
    return respond(502, "Upstream link service unavailable");
  }

  await ddb.send(new DeleteItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: marshall({ pk: `CAMPAIGN#${campaignId}`, sk: `LINK#${linkId}` }),
  }));

  return empty(204);
};

async function getLink(campaignId, linkId) {
  const result = await ddb.send(new GetItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: marshall({ pk: `CAMPAIGN#${campaignId}`, sk: `LINK#${linkId}` }),
  }));
  return result.Item ? unmarshall(result.Item) : null;
}

async function unmintShortLink(code) {
  const response = await fetch(`${process.env.NEWSLETTER_API_BASE_URL}/links/${code}`, {
    method: "DELETE",
    headers: { "Authorization": process.env.NEWSLETTER_MINT_API_KEY },
  });

  // 404 from upstream means the short code is already gone. Treat as success
  // and continue with the local delete so the two stores converge instead of
  // wedging on a stale upstream record.
  if (response.status === 404) {
    console.warn("Newsletter-service returned 404 for unmint; proceeding with local delete", { code });
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Unmint failed: ${response.status}`);
    err.statusCode = response.status;
    err.body = text;
    throw err;
  }
}
