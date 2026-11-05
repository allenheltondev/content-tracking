import { jsonResponse } from "../services/http-handler.mjs";
import { assertCampaignOwned } from "../domain/campaign.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { loadCampaignWebAnalytics } from "../services/campaign-web-analytics.mjs";

// GET /campaigns/:campaignId/web-analytics
//
// Pulls per-deliverable web analytics (GA4 + Core Web Vitals for a blog,
// YouTube stats for a video). The loading and partial-failure handling live
// in services/campaign-web-analytics.mjs, shared with the MCP tools.
export function registerWebAnalyticsRoutes(app) {
  app.get("/campaigns/:campaignId/web-analytics", async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    const campaign = await assertCampaignOwned(campaignId, tenantId);
    const qs = event.queryStringParameters ?? {};
    const result = await loadCampaignWebAnalytics(campaign, {
      startDate: qs.startDate,
      endDate: qs.endDate,
    });
    return jsonResponse(200, result);
  });
}
