import { jsonResponse } from "../services/http-handler.mjs";
import { UpstreamError } from "../services/errors.mjs";
import { findLink } from "../domain/link.mjs";
import { fetchLinkAnalytics } from "../services/newsletter-service.mjs";
import { getCampaignAnalytics } from "../services/campaign-analytics.mjs";

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

  // Campaign-level analytics. The aggregation lives in
  // services/campaign-analytics.mjs so the campaign report uses the exact
  // same numbers. The "all upstream calls failed" 502 is route policy: the
  // service still returns the object with upstream_failures === link_count.
  app.get("/campaigns/:campaignId/analytics", async ({ params }) => {
    const { campaignId } = params;
    const result = await getCampaignAnalytics(campaignId);

    if (result.link_count > 0 && result.upstream_failures === result.link_count) {
      return jsonResponse(502, { message: "All upstream analytics calls failed" });
    }

    return jsonResponse(200, result);
  });
}
