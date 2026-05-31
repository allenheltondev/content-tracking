import { getCampaignWithLinks } from "./campaign.mjs";
import { getProfileSettings } from "./profile.mjs";
import { splitPostMetrics } from "./post-metrics.mjs";
import { getCampaignAnalytics } from "../services/campaign-analytics.mjs";
import { loadCampaignGa4 } from "../services/campaign-ga4.mjs";
import { NotFoundError } from "../services/errors.mjs";

// Builds a frozen, customer-facing snapshot for a single campaign. Pulls
// click analytics (per-link + by source + by day), GA4 traffic on the
// campaign's main content (when configured), and the social/content posts
// the user is tracking. Everything is read-side glue — no I/O beyond the
// underlying services.

export async function buildCampaignReportSnapshot({ campaignId }) {
  const { metadata, socialPosts: socialPostRows, contentPosts: contentPostRows } =
    await getCampaignWithLinks(campaignId);
  if (!metadata) {
    throw new NotFoundError("Campaign", campaignId);
  }

  const [analytics, ga4, profile] = await Promise.all([
    getCampaignAnalytics(campaignId),
    loadCampaignGa4(metadata),
    getProfileSettings(),
  ]);

  const bySrc = Object.entries(analytics.by_src ?? {})
    .map(([source, clicks]) => ({
      source,
      clicks,
      share: analytics.total_clicks > 0 ? clicks / analytics.total_clicks : 0,
    }))
    .sort((a, b) => b.clicks - a.clicks);

  const byDay = Object.entries(analytics.by_day ?? {})
    .map(([day, clicks]) => ({ day, clicks }))
    .sort((a, b) => a.day.localeCompare(b.day));

  // Drop short_url from the public snapshot — the customer report shows the
  // destination URL and the click count, not our internal redirect URLs.
  const links = analytics.links
    .map((l) => ({
      url: l.url,
      role: l.role,
      platform: l.platform,
      totalClicks: l.total_clicks,
    }))
    .sort((a, b) => b.totalClicks - a.totalClicks);

  const mainContent = buildMainContent(ga4);
  const socialPosts = (socialPostRows ?? []).map(toPostSnapshot).sort(byEngagementDesc);
  const contentPosts = (contentPostRows ?? []).map(toPostSnapshot).sort(byEngagementDesc);
  const reach = buildReach({ mainContent, contentPosts, socialPosts });

  const now = new Date();

  return {
    schemaVersion: 1,
    report: {
      id: null,
      generatedAt: now.toISOString(),
      dataAsOf: now.toISOString().slice(0, 10),
      kind: "campaign",
    },
    brand: buildBrand(profile),
    campaign: {
      id: metadata.campaignId,
      name: metadata.name,
      sponsor: metadata.sponsor ?? null,
      startDate: metadata.startDate ?? null,
      endDate: metadata.endDate ?? null,
    },
    summary: {
      totalClicks: analytics.total_clicks,
      linkCount: analytics.link_count,
      upstreamFailures: analytics.upstream_failures,
    },
    reach,
    mainContent,
    bySrc,
    byDay,
    links,
    socialPosts,
    contentPosts,
  };
}

// The creator's own brand, shown at the top of the report so the sponsor
// sees who delivered the results. Null when no brand name is configured —
// the renderer hides the brand bar in that case. Website is optional.
function buildBrand(profile) {
  const name = profile?.brandName ?? null;
  if (!name) return null;
  return { name, websiteUrl: profile?.websiteUrl ?? null };
}

// Maps the GA4 section into the snapshot shape. Returns null when GA4
// isn't connected, errored, or produced no totals — the renderer hides
// the section in that case rather than showing empty tiles.
function buildMainContent(ga4) {
  if (!ga4 || !ga4.configured || ga4.error || !ga4.totals) return null;
  return {
    blogUrl: ga4.blog_url ?? null,
    range: ga4.range ?? null,
    pageviews: ga4.totals.pageviews,
    users: ga4.totals.users,
    sessions: ga4.totals.sessions,
    avgSessionDurationSeconds: ga4.totals.avg_session_duration,
    engagementRate: ga4.totals.engagement_rate,
  };
}

function toPostSnapshot(row) {
  const { views, impressions, engagements } = splitPostMetrics(row.analytics);
  // Top single metric across the whole map — an at-a-glance "what drove this
  // post" hint, independent of the reach/engagement split above.
  let topMetric = null;
  let topMetricValue = 0;
  if (row.analytics && typeof row.analytics === "object") {
    for (const [k, v] of Object.entries(row.analytics)) {
      const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
      if (n > topMetricValue) {
        topMetric = k;
        topMetricValue = n;
      }
    }
  }
  return {
    platform: row.platform,
    url: row.url,
    notes: row.notes ?? null,
    views,
    impressions,
    engagements,
    topMetric,
    topMetricValue,
    lastFetched: row.lastFetched ?? null,
  };
}

function byEngagementDesc(a, b) {
  return b.engagements - a.engagements;
}

// Rolls the per-post splits into two buckets the report leads with:
//   content = the main blog post (GA4) + every cross-post
//   social  = every social post
// GA4 has no discrete like/comment count, so the main post contributes only
// its pageviews to views; its engagement rate is shown in the main-content
// section but not folded into the bucket engagement total.
function buildReach({ mainContent, contentPosts, socialPosts }) {
  const content = { views: 0, impressions: 0, engagements: 0 };
  if (mainContent) {
    content.views += mainContent.pageviews || 0;
  }
  for (const p of contentPosts) {
    content.views += p.views;
    content.impressions += p.impressions;
    content.engagements += p.engagements;
  }

  const social = { views: 0, impressions: 0, engagements: 0 };
  for (const p of socialPosts) {
    social.views += p.views;
    social.impressions += p.impressions;
    social.engagements += p.engagements;
  }

  return {
    content,
    social,
    totals: {
      views: content.views + social.views,
      impressions: content.impressions + social.impressions,
      engagements: content.engagements + social.engagements,
    },
  };
}
