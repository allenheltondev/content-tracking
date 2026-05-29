import { getCampaignWithLinks } from "./campaign.mjs";
import { getCampaignAnalytics } from "../services/campaign-analytics.mjs";
import { NotFoundError } from "../services/errors.mjs";

// Builds a frozen, performance-facing snapshot for a single campaign.
// Mirrors the vendor report builder's style, but campaigns have no period
// and this report carries no payout — clicks/sources/days only. The numbers
// come straight from getCampaignAnalytics so the report agrees with
// GET /campaigns/{id}/analytics exactly.

export async function buildCampaignReportSnapshot({ campaignId }) {
  const { metadata } = await getCampaignWithLinks(campaignId);
  if (!metadata) {
    throw new NotFoundError("Campaign", campaignId);
  }

  const analytics = await getCampaignAnalytics(campaignId);

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

  const links = analytics.links
    .map((l) => ({
      url: l.url,
      shortUrl: l.short_url,
      role: l.role,
      platform: l.platform,
      totalClicks: l.total_clicks,
      firstClickAt: l.first_click_at,
      lastClickAt: l.last_click_at,
    }))
    .sort((a, b) => b.totalClicks - a.totalClicks);

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
    bySrc,
    byDay,
    links,
  };
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
