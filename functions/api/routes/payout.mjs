import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { updateCampaignPayout } from "../domain/campaign.mjs";
import { formatPayout, validatePayoutPayload } from "../validation/payout.mjs";

const formatCampaign = (row) => ({
  campaign_id: row.campaignId,
  name: row.name,
  sponsor: row.sponsor ?? null,
  vendor_id: row.vendorId ?? null,
  startDate: row.startDate ?? null,
  endDate: row.endDate ?? null,
  status: row.status,
  targetMetrics: row.targetMetrics ?? null,
  payout: formatPayout(row.payout),
  created_at: row.createdAt,
});

export function registerPayoutRoutes(app) {
  // PATCH /campaigns/{campaignId}/payout
  //
  // Partial update of payout sub-fields. The body is the inner payout
  // object (not wrapped under `payout: { ... }`). Sub-field nulls
  // (paid_at, invoice_ref) move into REMOVE clauses; amount and
  // currency cannot be nulled. paid=true with no paid_at defaults
  // paid_at to today; paid=false clears paid_at.
  app.patch("/campaigns/:campaignId/payout", async ({ event }) => {
    const { campaignId } = event.pathParameters ?? {};
    const body = parseBody(event);
    const fields = validatePayoutPayload(body, { partial: true });

    if (Object.keys(fields).length === 0) {
      throw new BadRequestError("request body must contain at least one payout field");
    }

    if (fields.paid === true && fields.paid_at === undefined) {
      fields.paid_at = new Date().toISOString().slice(0, 10);
    }
    if (fields.paid === false && fields.paid_at === undefined) {
      fields.paid_at = null;
    }

    const updated = await updateCampaignPayout(campaignId, fields);
    return jsonResponse(200, formatCampaign(updated));
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
