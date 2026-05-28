import { BadRequestError } from "../services/errors.mjs";
import { emptyResponse, jsonResponse } from "../services/http-handler.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import {
  formatSocialPost,
  validateAnalyticsUpdate,
  validateSocialPostCreate,
} from "../validation/social-post.mjs";
import {
  createSocialPost,
  deleteSocialPost,
  listActiveCampaignSocialPosts,
  listSocialPostSnapshots,
  listSocialPosts,
  updateSocialPostAnalytics,
} from "../domain/social-post.mjs";

export function registerSocialPostRoutes(app) {
  app.post("/campaigns/:campaignId/social-posts", withIdempotency(async ({ event, params }) => {
    const { campaignId } = params;
    const fields = validateSocialPostCreate(parseBody(event));
    const item = await createSocialPost(campaignId, fields);
    return jsonResponse(201, formatSocialPost(item));
  }));

  app.get("/campaigns/:campaignId/social-posts", async ({ params }) => {
    const { campaignId } = params;
    const items = await listSocialPosts(campaignId);
    return jsonResponse(200, {
      campaign_id: campaignId,
      social_posts: items
        .map(formatSocialPost)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    });
  });

  // PUT .../analytics — the Chrome extension's write path. Replaces the
  // post's metrics and stamps `last_fetched` server-side.
  app.put("/campaigns/:campaignId/social-posts/:postId/analytics", async ({ event, params }) => {
    const { campaignId, postId } = params;
    const fields = validateAnalyticsUpdate(parseBody(event));
    const updated = await updateSocialPostAnalytics(campaignId, postId, fields);
    return jsonResponse(200, formatSocialPost(updated));
  });

  // Per-day engagement history. Each snapshot is the final analytics map
  // recorded for the post on that calendar day (UTC). Used by the campaign
  // analytics UI to plot daily series.
  app.get("/campaigns/:campaignId/social-posts/:postId/snapshots", async ({ params }) => {
    const { campaignId, postId } = params;
    const snapshots = await listSocialPostSnapshots(campaignId, postId);
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

  app.delete("/campaigns/:campaignId/social-posts/:postId", async ({ params }) => {
    const { campaignId, postId } = params;
    await deleteSocialPost(campaignId, postId);
    return emptyResponse(204);
  });

  // Feed for the extension: every social post under a currently-active
  // campaign, with the campaign name for display and the current metrics
  // so the extension can skip re-writing unchanged numbers.
  app.get("/social-posts/active", async () => {
    const rows = await listActiveCampaignSocialPosts();
    return jsonResponse(200, {
      social_posts: rows.map(({ campaign, post }) => ({
        campaign_id: campaign.campaignId,
        campaign_name: campaign.name,
        ...formatSocialPost(post),
      })),
    });
  });
}

function parseBody(event) {
  if (!event.body) {
    throw new BadRequestError("Missing request body");
  }
  try {
    return JSON.parse(event.body);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}
