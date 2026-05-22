import { logger } from "../services/logger.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { UpstreamError } from "../services/errors.mjs";
import { findLink } from "../domain/link.mjs";
import { getCampaignWithLinks } from "../domain/campaign.mjs";
import { fetchLinkAnalytics } from "../services/newsletter-service.mjs";

const FANOUT_CONCURRENCY = parseInt(
  process.env.ANALYTICS_FANOUT_CONCURRENCY || "10", 10,
);

export function registerAnalyticsRoutes(app) {
  // Per-link analytics. Single upstream call to newsletter-service.
  app.get("/campaigns/:campaignId/links/:linkId/analytics", async ({ event }) => {
    const { campaignId, linkId } = event.pathParameters ?? {};
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

  // Campaign-level analytics. Fans out to newsletter-service per link
  // with limited concurrency. Partial failures get rolled up into the
  // response rather than aborting the whole call — matches the existing
  // get-campaign-analytics behavior.
  app.get("/campaigns/:campaignId/analytics", async ({ event }) => {
    const { campaignId } = event.pathParameters ?? {};
    const { links } = await getCampaignWithLinks(campaignId);

    if (links.length === 0) {
      return jsonResponse(200, {
        campaign_id: campaignId,
        link_count: 0,
        total_clicks: 0,
        by_role: {},
        by_platform: {},
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

function aggregate(perLink) {
  let totalClicks = 0;
  const byRole = {};
  const byPlatform = {};
  for (const { link, analytics } of perLink) {
    if (!analytics) continue;
    const clicks = analytics.total_clicks ?? 0;
    totalClicks += clicks;
    byRole[link.role] = (byRole[link.role] || 0) + clicks;
    byPlatform[link.platform] = (byPlatform[link.platform] || 0) + clicks;
  }
  return { total_clicks: totalClicks, by_role: byRole, by_platform: byPlatform };
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
