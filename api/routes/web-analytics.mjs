import { BadRequestError, NotFoundError } from "../services/errors.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { logger } from "../services/logger.mjs";
import { findCampaign, assertCampaignOwned } from "../domain/campaign.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { readCruxApiKey } from "../services/ga-secrets.mjs";
import { defaultGa4Range, loadGa4Section } from "../services/ga4.mjs";
import { fetchWebVitals } from "../services/core-web-vitals.mjs";
import { loadCampaignYoutube } from "../services/campaign-youtube.mjs";
import { ISO_DATE_RE } from "../validation/common.mjs";

// GET /campaigns/:campaignId/web-analytics
//
// Pulls per-deliverable web analytics. For a blog campaign that's GA4
// traffic (filtered by the URL's path) + Core Web Vitals (the full URL);
// for a YouTube campaign it's public video stats from the YouTube Data API.
// The response carries `deliverable_type` so the caller knows which section
// to read. Each source is fetched independently and a failure (or missing
// config) is reported inline rather than failing the whole call — mirrors
// the partial-failure handling in routes/analytics.mjs.
export function registerWebAnalyticsRoutes(app) {
  app.get("/campaigns/:campaignId/web-analytics", async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const campaign = await findCampaign(campaignId);
    if (!campaign) {
      throw new NotFoundError("Campaign", campaignId);
    }

    if ((campaign.deliverableType ?? "blog") === "youtube") {
      if (!campaign.youtubeUrl) {
        throw new BadRequestError("Campaign has no youtube_url. Set one to pull video analytics.");
      }
      const youtube = await loadCampaignYoutube(campaign);
      if (!youtube) {
        throw new BadRequestError(`Campaign youtube_url is not a valid YouTube URL: ${campaign.youtubeUrl}`);
      }
      return jsonResponse(200, {
        campaign_id: campaignId,
        deliverable_type: "youtube",
        youtube,
      });
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

    const [ga4, coreWebVitals] = await Promise.all([
      loadGa4Section({ pagePath, startDate, endDate }),
      loadCoreWebVitals({ url: campaign.blogUrl }),
    ]);

    return jsonResponse(200, {
      campaign_id: campaignId,
      deliverable_type: "blog",
      blog_url: campaign.blogUrl,
      page_path: pagePath,
      range: { startDate, endDate },
      ga4,
      core_web_vitals: coreWebVitals,
    });
  });
}

async function loadCoreWebVitals({ url }) {
  const cruxKey = await readCruxApiKey();
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
  const dflt = defaultGa4Range();
  const startDate = qs.startDate ?? dflt.startDate;
  const endDate = qs.endDate ?? dflt.endDate;

  if (!ISO_DATE_RE.test(startDate) || !ISO_DATE_RE.test(endDate)) {
    throw new BadRequestError("startDate and endDate must be YYYY-MM-DD");
  }
  if (startDate > endDate) {
    throw new BadRequestError("startDate must not be after endDate");
  }
  return { startDate, endDate };
}
