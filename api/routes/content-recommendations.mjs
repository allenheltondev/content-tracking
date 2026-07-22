import { NotFoundError } from "../services/errors.mjs";
import { jsonResponse, parseBody } from "../services/http-handler.mjs";
import { recommendEngagement } from "../services/bedrock/engagement.mjs";
import { fetchContentText } from "../services/content-fetch.mjs";
import { assertCampaignOwned, getCampaignWithLinks } from "../domain/campaign.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { getProfileSettings } from "../domain/profile.mjs";
import {
  getEngagementRecommendation,
  saveEngagementRecommendation,
} from "../domain/engagement-recommendation.mjs";
import {
  formatEngagementRecommendation,
  validateRecommendationRequest,
} from "../validation/engagement-recommendation.mjs";

// On-demand engagement recommendations for a single content post (the "work
// item"). Rather than firing automatically on creation, the user asks for
// recommendations when they want them — generation calls Bedrock and is the
// expensive part, so it stays explicit. The generated set is stored on the
// post so it can be re-read without re-spending on the model.

export function registerContentRecommendationRoutes(app) {
  // POST .../recommendations — generate a fresh set of cross-post / promotion
  // recommendations for this content post and store them.
  app.post("/campaigns/:campaignId/content-posts/:postId/recommendations", async ({ event, params }) => {
    const { campaignId, postId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const { goal } = validateRecommendationRequest(parseBody(event, { optional: true }));

    // One Query pulls the campaign and everything under it: the work item,
    // where it's already cross-posted, sibling content pieces, the social
    // posts that already promoted it, and the brief. The profile read runs
    // alongside it to learn the creator's personal site. getCampaignWithLinks
    // throws NotFound when the campaign doesn't exist.
    const [{ metadata, links, socialPosts, contentPosts, brief }, profile] =
      await Promise.all([getCampaignWithLinks(campaignId), getProfileSettings()]);

    const contentPost = contentPosts.find((p) => p.postId === postId);
    if (!contentPost) {
      throw new NotFoundError("ContentPost", postId);
    }

    const crossPostLinks = links.filter((l) => l.role === "cross_post");
    const otherContentPosts = contentPosts.filter((p) => p.postId !== postId);

    // Best-effort fetch of the published page so the agent reasons over the
    // actual prose. When the post is on the creator's configured personal
    // site, we pull its prebuilt plaintext; otherwise we scrape the HTML. A
    // failed fetch returns null and the agent falls back to URL, notes, brief.
    const plaintextHosts = personalSiteHosts(profile?.personalSiteUrl);
    const contentText = await fetchContentText(contentPost.url, { plaintextHosts });

    // Bedrock errors propagate as UpstreamError → 502; nothing is persisted on
    // failure, so a retry simply re-runs.
    const recommendation = await recommendEngagement({
      contentPost,
      campaign: metadata,
      brief,
      crossPostLinks,
      otherContentPosts,
      socialPosts,
      contentText,
      goal,
    });

    const saved = await saveEngagementRecommendation(campaignId, postId, recommendation);
    return jsonResponse(201, formatEngagementRecommendation(saved));
  });

  // GET .../recommendations — the most recently generated set for this post.
  app.get("/campaigns/:campaignId/content-posts/:postId/recommendations", async ({ event, params }) => {
    const { campaignId, postId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const stored = await getEngagementRecommendation(campaignId, postId);
    if (!stored) {
      throw new NotFoundError("ContentPostRecommendation", postId);
    }
    return jsonResponse(200, formatEngagementRecommendation(stored));
  });
}

// Derives the host(s) whose pages expose a /index.txt plaintext rendering
// from the creator's configured personal site URL. Returns [] when it's
// unset or unparseable, which means every URL takes the HTML-scrape path.
function personalSiteHosts(personalSiteUrl) {
  if (!personalSiteUrl) return [];
  try {
    return [new URL(personalSiteUrl).hostname];
  } catch {
    return [];
  }
}