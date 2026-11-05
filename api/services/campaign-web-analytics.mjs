import { BadRequestError } from "./errors.mjs";
import { logger } from "./logger.mjs";
import { readCruxApiKey } from "./ga-secrets.mjs";
import { defaultGa4Range, loadGa4Section } from "./ga4.mjs";
import { fetchWebVitals } from "./core-web-vitals.mjs";
import { loadCampaignYoutube } from "./campaign-youtube.mjs";
import { ISO_DATE_RE } from "../validation/common.mjs";

// Per-deliverable web analytics for a campaign, shared by
// GET /campaigns/{campaignId}/web-analytics and the MCP tools. For a blog
// campaign that's GA4 traffic (filtered by the URL's path) + Core Web Vitals
// (the full URL); for a YouTube campaign it's public video stats from the
// YouTube Data API. Each source is fetched independently and a failure (or
// missing config) is reported inline rather than failing the whole call.
// `campaign` is the stored row; the caller has already checked ownership.
export async function loadCampaignWebAnalytics(campaign, { startDate, endDate } = {}) {
  const campaignId = campaign.campaignId;

  if ((campaign.deliverableType ?? "blog") === "youtube") {
    if (!campaign.youtubeUrl) {
      throw new BadRequestError("Campaign has no youtube_url. Set one to pull video analytics.");
    }
    const youtube = await loadCampaignYoutube(campaign);
    if (!youtube) {
      throw new BadRequestError(`Campaign youtube_url is not a valid YouTube URL: ${campaign.youtubeUrl}`);
    }
    return { campaign_id: campaignId, deliverable_type: "youtube", youtube };
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

  const range = resolveRange({ startDate, endDate });
  const [ga4, coreWebVitals] = await Promise.all([
    loadGa4Section({ pagePath, ...range }),
    loadCoreWebVitals({ url: campaign.blogUrl }),
  ]);

  return {
    campaign_id: campaignId,
    deliverable_type: "blog",
    blog_url: campaign.blogUrl,
    page_path: pagePath,
    range,
    ga4,
    core_web_vitals: coreWebVitals,
  };
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

function resolveRange({ startDate, endDate }) {
  const dflt = defaultGa4Range();
  const start = startDate ?? dflt.startDate;
  const end = endDate ?? dflt.endDate;

  if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end)) {
    throw new BadRequestError("startDate and endDate must be YYYY-MM-DD");
  }
  if (start > end) {
    throw new BadRequestError("startDate must not be after endDate");
  }
  return { startDate: start, endDate: end };
}
