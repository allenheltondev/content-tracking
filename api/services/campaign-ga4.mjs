import { logger } from "./logger.mjs";
import { getProfileSettings } from "../domain/profile.mjs";
import { readGa4ServiceAccount } from "./ga-secrets.mjs";
import { fetchPageMetrics } from "./google-analytics.mjs";

// Shared GA4 loader: pulls per-page traffic for a campaign's blog URL so
// both the live web-analytics endpoint and the frozen campaign report
// snapshot read from the same code path. Always resolves — missing
// blog URL, missing config, and upstream failures all become a structured
// `configured`/`error` field rather than throwing.

const DEFAULT_RANGE_DAYS = 28;

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function defaultRange() {
  const end = new Date();
  const start = new Date(end.getTime() - (DEFAULT_RANGE_DAYS - 1) * 86400000);
  return { startDate: toIsoDate(start), endDate: toIsoDate(end) };
}

// Pull GA4 traffic for a campaign's blog post. Returns null when the
// campaign has no blog URL (nothing to look up) or the URL doesn't parse.
// Otherwise returns a section object with `configured` + (when configured
// and successful) the report payload.
export async function loadCampaignGa4(campaign, { startDate, endDate } = {}) {
  if (!campaign?.blogUrl) return null;

  let pagePath;
  try {
    pagePath = new URL(campaign.blogUrl).pathname || "/";
  } catch {
    return null;
  }

  const range = startDate && endDate ? { startDate, endDate } : defaultRange();

  const [settings, serviceAccount] = await Promise.all([
    getProfileSettings(),
    readGa4ServiceAccount(),
  ]);

  const propertyId = settings?.ga4PropertyId;
  if (!propertyId || !serviceAccount) {
    return { configured: false, error: null, blog_url: campaign.blogUrl, page_path: pagePath };
  }

  try {
    const report = await fetchPageMetrics({
      serviceAccount,
      propertyId,
      pagePath,
      startDate: range.startDate,
      endDate: range.endDate,
    });
    return { configured: true, error: null, blog_url: campaign.blogUrl, ...report };
  } catch (err) {
    logger.warn("GA4 fetch failed", { error: err?.message });
    return {
      configured: true,
      error: err?.message ?? "unknown",
      blog_url: campaign.blogUrl,
      page_path: pagePath,
    };
  }
}
