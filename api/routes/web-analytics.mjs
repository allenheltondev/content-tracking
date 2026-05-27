import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { logger } from "../services/logger.mjs";
import { findCampaign } from "../domain/campaign.mjs";
import { getProfileSettings } from "../domain/profile.mjs";
import { readCruxApiKey, readGa4ServiceAccount } from "../services/ga-secrets.mjs";
import { fetchPageMetrics } from "../services/google-analytics.mjs";
import { fetchWebVitals } from "../services/core-web-vitals.mjs";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 28;

// GET /campaigns/:campaignId/web-analytics
//
// Pulls GA4 traffic + Core Web Vitals for the campaign's blogUrl. GA4 is
// filtered by the URL's path; CWV uses the full URL. Each source is fetched
// independently and a failure (or missing config) in one is reported inline
// rather than failing the whole call — mirrors the partial-failure handling
// in routes/analytics.mjs.
export function registerWebAnalyticsRoutes(app) {
  app.get("/campaigns/:campaignId/web-analytics", async ({ event, params }) => {
    const { campaignId } = params;
    const campaign = await findCampaign(campaignId);
    if (!campaign) {
      return jsonResponse(404, { message: `Campaign ${campaignId} not found` });
    }
    if (!campaign.blogUrl) {
      throw new BadRequestError("Campaign has no blogUrl. Set one to pull web analytics.");
    }

    let pagePath;
    try {
      pagePath = new URL(campaign.blogUrl).pathname || "/";
    } catch {
      throw new BadRequestError(`Campaign blogUrl is not a valid URL: ${campaign.blogUrl}`);
    }

    const { startDate, endDate } = resolveRange(event.queryStringParameters ?? {});

    const [settings, serviceAccount, cruxKey] = await Promise.all([
      getProfileSettings(),
      readGa4ServiceAccount(),
      readCruxApiKey(),
    ]);

    const [ga4, coreWebVitals] = await Promise.all([
      loadGa4({ settings, serviceAccount, propertyId: settings?.ga4PropertyId, pagePath, startDate, endDate }),
      loadCoreWebVitals({ cruxKey, url: campaign.blogUrl }),
    ]);

    return jsonResponse(200, {
      campaign_id: campaignId,
      blog_url: campaign.blogUrl,
      page_path: pagePath,
      range: { startDate, endDate },
      ga4,
      core_web_vitals: coreWebVitals,
    });
  });
}

async function loadGa4({ serviceAccount, propertyId, pagePath, startDate, endDate }) {
  if (!propertyId || !serviceAccount) {
    return { configured: false, error: null };
  }
  try {
    const report = await fetchPageMetrics({ serviceAccount, propertyId, pagePath, startDate, endDate });
    return { configured: true, error: null, ...report };
  } catch (err) {
    logger.warn("GA4 fetch failed", { error: err?.message });
    return { configured: true, error: err?.message ?? "unknown" };
  }
}

async function loadCoreWebVitals({ cruxKey, url }) {
  if (!cruxKey) {
    return { configured: false, error: null };
  }
  try {
    const vitals = await fetchWebVitals({ url, apiKey: cruxKey });
    return { configured: true, error: null, ...vitals };
  } catch (err) {
    logger.warn("Core Web Vitals fetch failed", { error: err?.message });
    return { configured: true, error: err?.message ?? "unknown" };
  }
}

function resolveRange(qs) {
  const end = new Date();
  const start = new Date(end.getTime() - (DEFAULT_RANGE_DAYS - 1) * 86400000);
  const startDate = qs.startDate ?? toIsoDate(start);
  const endDate = qs.endDate ?? toIsoDate(end);

  if (!ISO_DATE_RE.test(startDate) || !ISO_DATE_RE.test(endDate)) {
    throw new BadRequestError("startDate and endDate must be YYYY-MM-DD");
  }
  if (startDate > endDate) {
    throw new BadRequestError("startDate must not be after endDate");
  }
  return { startDate, endDate };
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}
