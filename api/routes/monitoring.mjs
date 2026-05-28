import { jsonResponse } from "../services/http-handler.mjs";
import { listMonitoringWorkingSet } from "../domain/social-post.mjs";
import { listMonitoringContentPosts } from "../domain/content-post.mjs";
import { formatSocialPost } from "../validation/social-post.mjs";
import { formatContentPost } from "../validation/content-post.mjs";

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
  // two are written / consumed independently.
  app.get("/monitoring/working-set", async () => {
    const [{ socialPosts, crossPostLinks }, contentPosts] = await Promise.all([
      listMonitoringWorkingSet(),
      listMonitoringContentPosts(),
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
    });
  });
}
