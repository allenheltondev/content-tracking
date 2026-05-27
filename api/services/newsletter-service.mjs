import { logger } from "./logger.mjs";
import { getNewsletterApiBaseUrl } from "./params.mjs";
import { UpstreamError } from "./errors.mjs";

// Thin client for newsletter-service. Handles base-URL discovery (via
// Powertools SSM), the campaign-link API-key header, and translates
// upstream errors into UpstreamError so routes don't have to repeat
// status-code mapping.
//
// Base URL is fetched lazily and cached by Powertools for 5 min. The
// API key is still passed in as an env var (CFN deploy param). Could
// move to SSM SecureString + Powertools later if it becomes useful.

const MINT_KEY = process.env.NEWSLETTER_MINT_API_KEY;

async function buildUrl(path) {
  const base = await getNewsletterApiBaseUrl();
  return `${base}${path}`;
}

function authHeaders(extra = {}) {
  return {
    "Authorization": MINT_KEY,
    ...extra,
  };
}

export async function mintShortLink({ url, src, expiresInDays, campaignId }) {
  const body = { url };
  if (src) body.src = src;
  if (expiresInDays !== undefined) body.expiresInDays = expiresInDays;
  if (campaignId) body.campaignId = campaignId;

  const fetchUrl = await buildUrl("/links");
  const response = await fetch(fetchUrl, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    logger.error("Mint upstream call failed", { status: response.status, body: text });
    throw new UpstreamError(`Mint failed: ${text}`, response.status);
  }
  return JSON.parse(text);
}

// Deletes the upstream short-link record. A 404 from newsletter-service
// means the record is already gone — return ok so the caller can
// proceed with the local delete and the two stores converge.
export async function unmintShortLink(code) {
  const fetchUrl = await buildUrl(`/links/${code}`);
  const response = await fetch(fetchUrl, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (response.status === 404) {
    logger.warn("Newsletter-service 404 on unmint; proceeding with local delete", { code });
    return { alreadyGone: true };
  }
  if (!response.ok) {
    const text = await response.text();
    logger.error("Unmint upstream call failed", { status: response.status, body: text });
    throw new UpstreamError(`Unmint failed: ${text}`, response.status);
  }
  return { alreadyGone: false };
}

export async function fetchLinkAnalytics(code) {
  const fetchUrl = await buildUrl(`/links/${code}/analytics`);
  const response = await fetch(fetchUrl, {
    method: "GET",
    headers: authHeaders(),
  });
  const text = await response.text();
  if (!response.ok) {
    logger.error("Analytics upstream call failed", { code, status: response.status, body: text });
    throw new UpstreamError(`Analytics fetch failed: ${text}`, response.status);
  }
  return JSON.parse(text);
}

// One-shot analytics for every link tagged with a given campaignId.
// Returned shape (from newsletter-service):
//   { campaign_id, total_clicks, by_day, links: [{ code, url, src?, total_clicks, by_day, by_src, first_click_at, last_click_at }] }
// Caller joins on `code` to recover content-tracking's role/platform.
export async function fetchCampaignLinksAnalytics(campaignId) {
  const fetchUrl = await buildUrl(`/campaigns/${encodeURIComponent(campaignId)}/links/analytics`);
  const response = await fetch(fetchUrl, {
    method: "GET",
    headers: authHeaders(),
  });
  const text = await response.text();
  if (!response.ok) {
    logger.error("Campaign analytics upstream call failed", {
      campaignId,
      status: response.status,
      body: text,
    });
    throw new UpstreamError(`Campaign analytics fetch failed: ${text}`, response.status);
  }
  return JSON.parse(text);
}
