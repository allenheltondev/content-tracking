import { createSign } from "node:crypto";
import { logger } from "./logger.mjs";
import { UpstreamError } from "./errors.mjs";

// Thin client for the GA4 Data API. GA4 doesn't take a plain API key — it
// authenticates with a service account. We mint a short-lived OAuth access
// token by signing a JWT with the service account's private key (Node's
// built-in crypto, no SDK dependency) and exchanging it at Google's token
// endpoint, then call properties/{id}:runReport.
//
// The service account is passed in by the caller (loaded from SSM in the
// route) so this module stays a pure HTTP client and is testable without
// touching AWS.

const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA_API_BASE = "https://analyticsdata.googleapis.com/v1beta";

// Access tokens are valid ~1h. Cache per client_email across invocations in
// the same execution environment so a burst of report calls reuses one token.
let cachedToken = null;

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

async function getAccessToken(serviceAccount) {
  const { client_email: clientEmail, private_key: privateKey } = serviceAccount;
  if (!clientEmail || !privateKey) {
    throw new UpstreamError("GA4 service account is missing client_email or private_key", 500);
  }

  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.clientEmail === clientEmail && cachedToken.expiresAt - 60 > now) {
    return cachedToken.token;
  }

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: clientEmail,
    scope: GA4_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;

  let signature;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signature = signer.sign(privateKey, "base64url");
  } catch (err) {
    logger.error("GA4 JWT signing failed", { error: err?.message });
    throw new UpstreamError("GA4 service account private key is invalid", 500);
  }

  const assertion = `${signingInput}.${signature}`;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    logger.error("GA4 token exchange failed", { status: response.status, body: text });
    throw new UpstreamError(`GA4 auth failed: ${text}`, response.status);
  }
  const json = JSON.parse(text);
  cachedToken = {
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600),
    clientEmail,
  };
  return cachedToken.token;
}

// Runs a per-page report for one blog page path over [startDate, endDate].
// Returns aggregated totals (GA4-computed, so users/sessions are properly
// deduped) plus a pageviews-per-day series for charting.
export async function fetchPageMetrics({ serviceAccount, propertyId, pagePath, startDate, endDate }) {
  const token = await getAccessToken(serviceAccount);

  const body = {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "date" }],
    metrics: [
      { name: "screenPageViews" },
      { name: "totalUsers" },
      { name: "sessions" },
      { name: "averageSessionDuration" },
      { name: "engagementRate" },
      { name: "bounceRate" },
    ],
    dimensionFilter: {
      filter: {
        fieldName: "pagePath",
        stringFilter: { matchType: "EXACT", value: pagePath },
      },
    },
    metricAggregations: ["TOTAL"],
    orderBys: [{ dimension: { dimensionName: "date" } }],
    limit: 100000,
  };

  const response = await fetch(`${DATA_API_BASE}/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    logger.error("GA4 runReport failed", { propertyId, status: response.status, body: text });
    throw new UpstreamError(`GA4 report failed: ${text}`, response.status);
  }

  return parseReport(JSON.parse(text), { propertyId, pagePath, startDate, endDate });
}

function parseReport(json, { propertyId, pagePath, startDate, endDate }) {
  const headers = (json.metricHeaders ?? []).map((h) => h.name);
  const idx = (name) => headers.indexOf(name);
  const num = (values, name) => {
    const i = idx(name);
    return i < 0 ? 0 : Number(values?.[i]?.value ?? 0);
  };

  const totalsRow = json.totals?.[0]?.metricValues ?? [];
  const totals = {
    pageviews: num(totalsRow, "screenPageViews"),
    users: num(totalsRow, "totalUsers"),
    sessions: num(totalsRow, "sessions"),
    avg_session_duration: round(num(totalsRow, "averageSessionDuration"), 2),
    engagement_rate: round(num(totalsRow, "engagementRate"), 4),
    bounce_rate: round(num(totalsRow, "bounceRate"), 4),
  };

  const byDay = {};
  for (const row of json.rows ?? []) {
    const raw = row.dimensionValues?.[0]?.value ?? "";
    if (raw.length !== 8) continue;
    const day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    byDay[day] = num(row.metricValues, "screenPageViews");
  }

  return {
    property_id: String(propertyId),
    page_path: pagePath,
    range: { startDate, endDate },
    totals,
    by_day: byDay,
  };
}

function round(value, places) {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
