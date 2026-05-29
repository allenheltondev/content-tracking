import { getCampaignWithLinks } from "./campaign.mjs";
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

  const [analytics, ga4] = await Promise.all([
    getCampaignAnalytics(campaignId),
    loadCampaignGa4(metadata),
  ]);

  const { firstClickAt, lastClickAt } = deriveClickBounds(analytics.links);

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
  const socialPosts = (socialPostRows ?? []).map(toPostSnapshot).sort(byTotalDesc);
  const contentPosts = (contentPostRows ?? []).map(toPostSnapshot).sort(byTotalDesc);

  const now = new Date();

  return {
    schemaVersion: 1,
    report: {
      id: null,
      generatedAt: now.toISOString(),
      dataAsOf: now.toISOString().slice(0, 10),
      kind: "campaign",
    },
    campaign: {
      id: metadata.campaignId,
      name: metadata.name,
      sponsor: metadata.sponsor ?? null,
      startDate: metadata.startDate ?? null,
      endDate: metadata.endDate ?? null,
      status: metadata.status,
    },
    summary: {
      totalClicks: analytics.total_clicks,
      linkCount: analytics.link_count,
      firstClickAt,
      lastClickAt,
      upstreamFailures: analytics.upstream_failures,
    },
    mainContent,
    bySrc,
    byDay,
    links,
    socialPosts,
    contentPosts,
  };
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
  let total = 0;
  let topMetric = null;
  let topMetricValue = 0;
  if (row.analytics && typeof row.analytics === "object") {
    for (const [k, v] of Object.entries(row.analytics)) {
      const n = typeof v === "number" ? v : 0;
      total += n;
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
    totalEngagement: total,
    topMetric,
    topMetricValue,
    lastFetched: row.lastFetched ?? null,
  };
}

function byTotalDesc(a, b) {
  return b.totalEngagement - a.totalEngagement;
}

// Earliest non-null first_click_at and latest non-null last_click_at across
// the analytics links. ISO-8601 timestamps sort lexically, so string compare
// is correct. Returns nulls when no link has a click.
function deriveClickBounds(links) {
  let firstClickAt = null;
  let lastClickAt = null;
  for (const l of links ?? []) {
    if (l.first_click_at && (firstClickAt === null || l.first_click_at < firstClickAt)) {
      firstClickAt = l.first_click_at;
    }
    if (l.last_click_at && (lastClickAt === null || l.last_click_at > lastClickAt)) {
      lastClickAt = l.last_click_at;
    }
  }
  return { firstClickAt, lastClickAt };
}
