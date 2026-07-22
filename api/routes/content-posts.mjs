import { emptyResponse, jsonResponse, parseBody } from "../services/http-handler.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import {
  formatContentPost,
  validateAnalyticsUpdate,
  validateContentPostCreate,
} from "../validation/content-post.mjs";
import {
  createContentPost,
  deleteContentPost,
  listContentPostSnapshots,
  listContentPosts,
  updateContentPostAnalytics,
} from "../domain/content-post.mjs";
import { assertCampaignOwned } from "../domain/campaign.mjs";
import { requireTenantId, resolveTenantId } from "../services/identity.mjs";

export function registerContentPostRoutes(app) {
  app.post("/campaigns/:campaignId/content-posts", withIdempotency(async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const fields = validateContentPostCreate(parseBody(event));
    const item = await createContentPost(campaignId, fields);
    return jsonResponse(201, formatContentPost(item));
  }));

  app.get("/campaigns/:campaignId/content-posts", async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const items = await listContentPosts(campaignId);
    return jsonResponse(200, {
      campaign_id: campaignId,
      content_posts: items
        .map(formatContentPost)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    });
  });

  // PUT .../analytics — the Chrome extension's content-bucket write path.
  // Replaces the post's metrics and stamps `last_fetched` server-side. Like
  // the social-post analytics write, the extension pairs with an HMAC token
  // (authSource="extension"), so resolve the tenant from either auth path.
  app.put("/campaigns/:campaignId/content-posts/:postId/analytics", async ({ event, params }) => {
    const { campaignId, postId } = params;
    const tenantId = resolveTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const fields = validateAnalyticsUpdate(parseBody(event));
    const updated = await updateContentPostAnalytics(campaignId, postId, fields);
    return jsonResponse(200, formatContentPost(updated));
  });

  // Per-day engagement history for a content post — same shape as the
  // social-post snapshots endpoint so the dashboard's charting helpers
  // can be reused.
  app.get("/campaigns/:campaignId/content-posts/:postId/snapshots", async ({ event, params }) => {
    const { campaignId, postId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const snapshots = await listContentPostSnapshots(campaignId, postId);
    return jsonResponse(200, {
      campaign_id: campaignId,
      post_id: postId,
      snapshots: snapshots.map((s) => ({
        snapshot_date: s.snapshotDate,
        metrics: s.metrics,
        captured_at: s.capturedAt ?? null,
        recorded_at: s.recordedAt,
      })),
    });
  });

  app.delete("/campaigns/:campaignId/content-posts/:postId", async ({ event, params }) => {
    const { campaignId, postId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    await deleteContentPost(campaignId, postId);
    return emptyResponse(204);
  });
}