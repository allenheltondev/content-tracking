import { logger } from "./logger.mjs";
import { UpstreamError } from "./errors.mjs";
import { FANOUT_CONCURRENCY, runInBatches } from "./concurrency.mjs";
import { getCampaignWithLinks } from "../domain/campaign.mjs";
import {
  fetchCampaignLinksAnalytics,
  fetchLinkAnalytics,
} from "./newsletter-service.mjs";

// Campaign-level analytics aggregation. Two paths:
//   - If the campaign has a link_tracking_id, ask newsletter-service for
//     every link tagged with that campaignId in one call and join with
//     the local link rows on `code` for role/platform.
//   - Otherwise, fall back to fanning out per local link with limited
//     concurrency. Partial failures roll up into the response.
//
// Never throws on partial upstream failures — those roll into
// `upstream_failures`. Non-UpstreamError errors propagate. The "all
// upstream calls failed" 502 decision is the route's policy, not this
// service's: when every fanout call fails, this returns the object with
// upstream_failures === link_count.
export async function getCampaignAnalytics(campaignId) {
  const { metadata, links } = await getCampaignWithLinks(campaignId);

  if (metadata.linkTrackingId) {
    return analyticsViaCampaignId(campaignId, metadata.linkTrackingId, links);
  }

  if (links.length === 0) {
    return {
      campaign_id: campaignId,
      link_count: 0,
      total_clicks: 0,
      by_role: {},
      by_platform: {},
      by_day: {},
      by_src: {},
      upstream_failures: 0,
      links: [],
    };
  }

  const perLink = await runInBatches(
    links.map((link) => async () => {
      try {
        const analytics = await fetchLinkAnalytics(link.code);
        return { link, analytics, error: null };
      } catch (err) {
        logger.warn("Per-link analytics failed", { linkId: link.linkId, error: err?.message });
        return { link, analytics: null, error: err?.message ?? "unknown" };
      }
    }),
    FANOUT_CONCURRENCY,
  );

  const failures = perLink.filter((r) => r.error);
  const rollup = aggregate(perLink);

  return {
    campaign_id: campaignId,
    link_count: links.length,
    ...rollup,
    upstream_failures: failures.length,
    links: perLink.map(({ link, analytics, error }) => ({
      link_id: link.linkId,
      code: link.code,
      short_url: link.shortUrl ?? null,
      role: link.role,
      platform: link.platform,
      url: link.url,
      src: link.src ?? null,
      total_clicks: analytics?.total_clicks ?? 0,
      by_day: analytics?.by_day ?? {},
      by_src: analytics?.by_src ?? {},
      first_click_at: analytics?.first_click_at ?? null,
      last_click_at: analytics?.last_click_at ?? null,
      error,
    })),
  };
}

// Single-call analytics path. Asks newsletter-service for every link
// tagged with `linkTrackingId`, then joins on `code` to recover the
// content-tracking role/platform/link_id. Newsletter-service may include
// links the local store doesn't know about (e.g., minted out of band) —
// those flow through with role/platform null.
async function analyticsViaCampaignId(campaignId, linkTrackingId, localLinks) {
  let upstream;
  try {
    upstream = await fetchCampaignLinksAnalytics(linkTrackingId);
  } catch (err) {
    if (err instanceof UpstreamError) {
      return {
        campaign_id: campaignId,
        link_count: localLinks.length,
        total_clicks: 0,
        by_role: {},
        by_platform: {},
        by_day: {},
        by_src: {},
        upstream_failures: 1,
        links: [],
      };
    }
    throw err;
  }

  const localByCode = new Map(localLinks.map((l) => [l.code, l]));
  const upstreamLinks = Array.isArray(upstream?.links) ? upstream.links : [];

  const byRole = {};
  const byPlatform = {};
  const byDay = {};
  const bySrc = {};
  let totalClicks = 0;
  const outLinks = [];

  for (const u of upstreamLinks) {
    // newsletter-service nests per-link click stats under `analytics`. The
    // outer fields (url, src, expires_at) describe the link record itself.
    const stats = u.analytics ?? {};
    const local = localByCode.get(u.code);
    const clicks = stats.total_clicks ?? 0;
    totalClicks += clicks;
    if (local) {
      byRole[local.role] = (byRole[local.role] || 0) + clicks;
      byPlatform[local.platform] = (byPlatform[local.platform] || 0) + clicks;
    }
    if (stats.by_day && typeof stats.by_day === "object") {
      for (const [day, count] of Object.entries(stats.by_day)) {
        const n = typeof count === "number" ? count : 0;
        byDay[day] = (byDay[day] || 0) + n;
      }
    }
    if (stats.by_src && typeof stats.by_src === "object") {
      for (const [src, count] of Object.entries(stats.by_src)) {
        const n = typeof count === "number" ? count : 0;
        const key = src ?? "unknown";
        bySrc[key] = (bySrc[key] || 0) + n;
      }
    }
    outLinks.push({
      link_id: local?.linkId ?? null,
      code: u.code,
      short_url: u.short_url ?? local?.shortUrl ?? null,
      role: local?.role ?? null,
      platform: local?.platform ?? null,
      url: local?.url ?? u.url ?? null,
      src: u.src ?? local?.src ?? null,
      total_clicks: clicks,
      by_day: stats.by_day ?? {},
      by_src: stats.by_src ?? {},
      first_click_at: stats.first_click_at ?? null,
      last_click_at: stats.last_click_at ?? null,
      error: null,
    });
  }

  return {
    campaign_id: campaignId,
    link_count: outLinks.length,
    total_clicks: totalClicks,
    by_role: byRole,
    by_platform: byPlatform,
    by_day: byDay,
    by_src: bySrc,
    upstream_failures: 0,
    links: outLinks,
  };
}

function aggregate(perLink) {
  let totalClicks = 0;
  const byRole = {};
  const byPlatform = {};
  const byDay = {};
  const bySrc = {};
  for (const { link, analytics } of perLink) {
    if (!analytics) continue;
    const clicks = analytics.total_clicks ?? 0;
    totalClicks += clicks;
    byRole[link.role] = (byRole[link.role] || 0) + clicks;
    byPlatform[link.platform] = (byPlatform[link.platform] || 0) + clicks;
    if (analytics.by_day && typeof analytics.by_day === "object") {
      for (const [day, count] of Object.entries(analytics.by_day)) {
        const n = typeof count === "number" ? count : 0;
        byDay[day] = (byDay[day] || 0) + n;
      }
    }
    if (analytics.by_src && typeof analytics.by_src === "object") {
      for (const [src, count] of Object.entries(analytics.by_src)) {
        const n = typeof count === "number" ? count : 0;
        const key = src ?? "unknown";
        bySrc[key] = (bySrc[key] || 0) + n;
      }
    }
  }
  return {
    total_clicks: totalClicks,
    by_role: byRole,
    by_platform: byPlatform,
    by_day: byDay,
    by_src: bySrc,
  };
}

