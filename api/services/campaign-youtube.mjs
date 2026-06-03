import { logger } from "./logger.mjs";
import { readYoutubeApiKey } from "./ga-secrets.mjs";
import { extractYoutubeVideoId, fetchVideoStats } from "./youtube.mjs";

// Shared YouTube loader: pulls public stats for a campaign whose main
// deliverable is a YouTube video, so both the live web-analytics endpoint
// and the frozen campaign report snapshot read from the same code path.
// The YouTube counterpart to campaign-ga4.mjs. Always resolves — a campaign
// that isn't a YouTube campaign, a missing/invalid URL, a missing API key,
// and upstream failures all become null or a structured `configured`/`error`
// field rather than throwing.

// Returns null when the campaign's deliverable isn't YouTube or the video
// URL is missing/unparseable (nothing to look up). Otherwise returns a
// section object with `configured` + (when configured and successful) the
// stats payload.
export async function loadCampaignYoutube(campaign) {
  if (campaign?.deliverableType !== "youtube" || !campaign?.youtubeUrl) return null;

  const videoId = extractYoutubeVideoId(campaign.youtubeUrl);
  if (!videoId) return null;

  const apiKey = await readYoutubeApiKey();
  if (!apiKey) {
    return { configured: false, error: null, youtube_url: campaign.youtubeUrl, video_id: videoId };
  }

  try {
    const stats = await fetchVideoStats({ videoId, apiKey });
    if (!stats) {
      return {
        configured: true,
        error: "Video not found or not public",
        youtube_url: campaign.youtubeUrl,
        video_id: videoId,
      };
    }
    return { configured: true, error: null, youtube_url: campaign.youtubeUrl, ...stats };
  } catch (err) {
    logger.warn("YouTube fetch failed", { error: err?.message });
    return {
      configured: true,
      error: err?.message ?? "unknown",
      youtube_url: campaign.youtubeUrl,
      video_id: videoId,
    };
  }
}
