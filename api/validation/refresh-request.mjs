// Response shaper for a pending campaign refresh request, as the Chrome
// extension reads it from GET /monitoring/working-set. The request bodies on
// the refresh endpoints are ignored, so there is nothing to validate here;
// the sweep-complete path param uses requireCampaignId from common.mjs.

export function formatRefreshRequest(item) {
  return {
    campaign_id: item.campaignId,
    requested_at: item.requestedAt,
  };
}
