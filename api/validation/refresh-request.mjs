// Response shaper for a pending campaign refresh request, as the Chrome
// extension reads it from GET /monitoring/working-set, and the validator for
// the optional sweep-complete body. The sweep-complete path param uses
// requireCampaignId from common.mjs.

import { BadRequestError } from "../services/errors.mjs";

// Body of POST /monitoring/campaigns/:campaignId/sweep-complete. Optional.
// `partial: true` means some posts failed to sync during the sweep.
export function validateSweepComplete(body) {
  if (body === undefined || body === null) return { partial: false };
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("Request body must be a JSON object");
  }
  if (body.partial !== undefined && typeof body.partial !== "boolean") {
    throw new BadRequestError("partial must be a boolean");
  }
  return { partial: body.partial === true };
}

export function formatRefreshRequest(item) {
  return {
    campaign_id: item.campaignId,
    requested_at: item.requestedAt,
  };
}
