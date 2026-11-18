import { randomBytes } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_NAME, ddb, isConditionalCheckFailed } from "../services/ddb.mjs";

// A campaign's stable report link: one unguessable token per campaign that
// the public GET /public/campaign-reports/{token} route resolves to the
// newest report snapshot. Sponsors keep a single link for the life of the
// campaign while each snapshot stays frozen.
//
// Two items, written together:
//   pk = CAMPAIGN#{campaignId}, sk = REPORTLINK   -> the campaign's token
//   pk = REPORTLINK#{token},    sk = REPORTLINK   -> reverse lookup
// The campaign item also holds `refreshClaimedAt`, the cooldown claim for
// the public refresh route (claimCampaignReportRefresh).
// Neither carries a TTL: the link outlives any single report. When every
// report has aged out, the public route answers with a "no longer
// available" page instead of redirecting.

const SK = "REPORTLINK";

// 16 random bytes, base64url-encoded: 22 chars, 128 bits of entropy.
export const REPORT_LINK_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

function campaignLinkKey(campaignId) {
  return { pk: `CAMPAIGN#${campaignId}`, sk: SK };
}

function tokenLookupKey(token) {
  return { pk: `REPORTLINK#${token}`, sk: SK };
}

export async function getCampaignReportLinkToken(campaignId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: campaignLinkKey(campaignId),
  }));
  return result.Item?.token ?? null;
}

// Returns the campaign's token, creating it on first use. The condition on
// the campaign item makes concurrent first-time generations converge: the
// loser's transaction is cancelled and it re-reads the winner's token.
export async function ensureCampaignReportLinkToken(campaignId) {
  const existing = await getCampaignReportLinkToken(campaignId);
  if (existing) return existing;

  const token = randomBytes(16).toString("base64url");
  const createdAt = new Date().toISOString();
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: { ...campaignLinkKey(campaignId), entity: "CampaignReportLink", campaignId, token, createdAt },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: { ...tokenLookupKey(token), entity: "CampaignReportLinkLookup", campaignId, token, createdAt },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    }));
    return token;
  } catch (err) {
    if (err?.name !== "TransactionCanceledException") throw err;
    const winner = await getCampaignReportLinkToken(campaignId);
    if (!winner) throw err;
    return winner;
  }
}

// Claims the right to regenerate the campaign's report from the public
// refresh route. The claim is a timestamp on the campaign's link item and
// succeeds only when no claim landed within `cooldownMs`, so concurrent or
// repeated submits of the public form trigger at most one generation per
// cooldown window. Returns false when another claim is still fresh. The
// attribute_exists guard keeps a claim from creating a token-less stub.
export async function claimCampaignReportRefresh(campaignId, { cooldownMs }) {
  const nowMs = Date.now();
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: campaignLinkKey(campaignId),
      UpdateExpression: "SET refreshClaimedAt = :now",
      ConditionExpression:
        "attribute_exists(pk) AND (attribute_not_exists(refreshClaimedAt) OR refreshClaimedAt <= :cutoff)",
      ExpressionAttributeValues: {
        ":now": new Date(nowMs).toISOString(),
        ":cutoff": new Date(nowMs - cooldownMs).toISOString(),
      },
    }));
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

export async function resolveCampaignReportLinkToken(token) {
  if (!REPORT_LINK_TOKEN_RE.test(token ?? "")) return null;
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: tokenLookupKey(token),
  }));
  return result.Item?.campaignId ?? null;
}

// Public URL for a token, rooted at whichever API host served the request.
// The prefix is whatever sits in front of the routed path: "/v1" on the
// execute-api hostname, nothing on the custom domain (its base path mapping
// is empty). Null when the event carries no host, e.g. a local invoke.
export function publicReportLinkUrl(event, token) {
  const host = event?.requestContext?.domainName;
  if (!host || !token) return null;
  const fullPath = event.requestContext.path ?? "";
  const routedPath = event.path ?? "";
  const prefix = routedPath && fullPath.endsWith(routedPath)
    ? fullPath.slice(0, fullPath.length - routedPath.length)
    : "";
  return `https://${host}${prefix}/public/campaign-reports/${token}`;
}
