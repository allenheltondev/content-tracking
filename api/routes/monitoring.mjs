import { jsonResponse } from "../services/http-handler.mjs";
import { resolveTenantId } from "../services/identity.mjs";
import { assertCampaignOwned } from "../domain/campaign.mjs";
import { listMonitoringWorkingSet } from "../domain/social-post.mjs";
import { listMonitoringContentPosts } from "../domain/content-post.mjs";
import { publicReportLinkUrl } from "../domain/campaign-report-link.mjs";
import { listPendingRefreshRequests } from "../domain/campaign-refresh-request.mjs";
import { completeMonitoringSweep } from "../services/campaign-report-refresh.mjs";
import { formatSocialPost } from "../validation/social-post.mjs";
import { formatContentPost } from "../validation/content-post.mjs";
import { formatRefreshRequest } from "../validation/refresh-request.mjs";
import { requireCampaignId } from "../validation/common.mjs";

const formatCrossPostLink = (row) => ({
  campaign_id: row.campaignId,
  link_id: row.linkId,
  code: row.code,
  short_url: row.shortUrl,
  role: row.role,
  platform: row.platform,
  url: row.url,
  src: row.src ?? null,
  notes: row.notes ?? null,
  expires_at: row.expiresAt,
  created_at: row.createdAt,
});

export function registerMonitoringRoutes(app) {
  // The Chrome extension's monitoring-phase working set: every social post,
  // every content post, and every cross-post link belonging to a campaign
  // whose status is "monitoring". Each item is pre-joined to its campaign
  // so the extension can render the campaign name without a second round
  // trip. Social and content posts run as parallel queries because the
  // two are written / consumed independently. `refresh_requests` lists the
  // campaigns a sponsor asked to refresh from the report page, so the
  // extension can re-scrape them ahead of its usual schedule.
  app.get("/monitoring/working-set", async ({ event }) => {
    const tenantId = resolveTenantId(event);
    const [{ socialPosts, crossPostLinks }, contentPosts, refreshRequests] = await Promise.all([
      listMonitoringWorkingSet(tenantId),
      listMonitoringContentPosts(tenantId),
      listPendingRefreshRequests(tenantId),
    ]);
    return jsonResponse(200, {
      social_posts: socialPosts.map(({ campaign, post }) => ({
        campaign_id: campaign.campaignId,
        campaign_name: campaign.name,
        ...formatSocialPost(post),
      })),
      content_posts: contentPosts.map(({ campaign, post }) => ({
        campaign_id: campaign.campaignId,
        campaign_name: campaign.name,
        ...formatContentPost(post),
      })),
      cross_post_links: crossPostLinks.map(({ campaign, link }) => ({
        campaign_name: campaign.name,
        ...formatCrossPostLink(link),
      })),
      refresh_requests: refreshRequests.map(formatRefreshRequest),
    });
  });

  // POST /monitoring/campaigns/:campaignId/sweep-complete
  //
  // The extension calls this after it finishes scraping a campaign's posts.
  // Clears the campaign's pending refresh request and regenerates its
  // sponsor report when there is something new to show. The body is
  // ignored. Not wrapped in withIdempotency: the extension sends no
  // idempotency key, and a repeat call finds nothing pending and no posts
  // newer than the report it just generated, so it is a no-op.
  app.post("/monitoring/campaigns/:campaignId/sweep-complete", async ({ event, params }) => {
    const campaignId = requireCampaignId(params.campaignId);
    const tenantId = resolveTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const { regenerated } = await completeMonitoringSweep({
      tenantId,
      campaignId,
      latestUrlFor: (token) => publicReportLinkUrl(event, token),
    });
    return jsonResponse(200, { campaign_id: campaignId, regenerated });
  });
}
