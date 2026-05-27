import { logger } from "../services/logger.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { UpstreamError } from "../services/errors.mjs";
import { findLink } from "../domain/link.mjs";
import { getCampaignWithLinks } from "../domain/campaign.mjs";
import {
  fetchCampaignLinksAnalytics,
  fetchLinkAnalytics,
} from "../services/newsletter-service.mjs";

const FANOUT_CONCURRENCY = parseInt(
  process.env.ANALYTICS_FANOUT_CONCURRENCY || "10", 10,
);

export function registerAnalyticsRoutes(app) {
  // Per-link analytics. Single upstream call to newsletter-service.
  app.get("/campaigns/:campaignId/links/:linkId/analytics", async ({ params }) => {
    const { campaignId, linkId } = params;
    const link = await findLink(campaignId, linkId);
    if (!link) {
      return jsonResponse(404, { message: `Link ${linkId} not found in campaign ${campaignId}` });
    }

    let analytics;
    try {
      analytics = await fetchLinkAnalytics(link.code);
    } catch (err) {
      if (err instanceof UpstreamError) {
        return jsonResponse(502, { message: "Upstream analytics service unavailable" });
      }
      throw err;
    }

    return jsonResponse(200, {
      campaign_id: campaignId,
      link_id: linkId,
      code: link.code,
      role: link.role,
      platform: link.platform,
      url: link.url,
      analytics,
    });
  });

  // Campaign-level analytics. Two paths:
  //   - If the campaign has a link_tracking_id, ask newsletter-service for
  //     every link tagged with that campaignId in one call and join with
  //     the local link rows on `code` for role/platform.
  //   - Otherwise, fall back to fanning out per local link with limited
  //     concurrency. Partial failures roll up into the response.
  app.get("/campaigns/:campaignId/analytics", async ({ params }) => {
    const { campaignId } = params;
    const { metadata, links } = await getCampaignWithLinks(campaignId);

    if (metadata.linkTrackingId) {
      return jsonResponse(200, await analyticsViaCampaignId(campaignId, metadata.linkTrackingId, links));
    }

    if (links.length === 0) {
      return jsonResponse(200, {
        campaign_id: campaignId,
        link_count: 0,
        total_clicks: 0,
        by_role: {},
        by_platform: {},
        by_day: {},
        upstream_failures: 0,
        links: [],
      });
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
    if (failures.length === links.length) {
      return jsonResponse(502, { message: "All upstream analytics calls failed" });
    }

    const rollup = aggregate(perLink);

    return jsonResponse(200, {
      campaign_id: campaignId,
      link_count: links.length,
      ...rollup,
      upstream_failures: failures.length,
      links: perLink.map(({ link, analytics, error }) => ({
        link_id: link.linkId,
        code: link.code,
        role: link.role,
        platform: link.platform,
        url: link.url,
        total_clicks: analytics?.total_clicks ?? 0,
        first_click_at: analytics?.first_click_at ?? null,
        last_click_at: analytics?.last_click_at ?? null,
        error,
      })),
    });
  });
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
  let totalClicks = 0;
  const outLinks = [];

  for (const u of upstreamLinks) {
    const local = localByCode.get(u.code);
    const clicks = u.total_clicks ?? 0;
    totalClicks += clicks;
    if (local) {
      byRole[local.role] = (byRole[local.role] || 0) + clicks;
      byPlatform[local.platform] = (byPlatform[local.platform] || 0) + clicks;
    }
    if (u.by_day && typeof u.by_day === "object") {
      for (const [day, count] of Object.entries(u.by_day)) {
        const n = typeof count === "number" ? count : 0;
        byDay[day] = (byDay[day] || 0) + n;
      }
    }
    outLinks.push({
      link_id: local?.linkId ?? null,
      code: u.code,
      role: local?.role ?? null,
      platform: local?.platform ?? null,
      url: local?.url ?? u.url ?? null,
      total_clicks: clicks,
      first_click_at: u.first_click_at ?? null,
      last_click_at: u.last_click_at ?? null,
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
    upstream_failures: 0,
    links: outLinks,
  };
}

function aggregate(perLink) {
  let totalClicks = 0;
  const byRole = {};
  const byPlatform = {};
  const byDay = {};
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
  }
  return { total_clicks: totalClicks, by_role: byRole, by_platform: byPlatform, by_day: byDay };
}

async function runInBatches(ops, batchSize) {
  const results = [];
  for (let i = 0; i < ops.length; i += batchSize) {
    const batch = ops.slice(i, i + batchSize);
    const settled = await Promise.all(batch.map((fn) => fn()));
    results.push(...settled);
  }
  return results;
}
