import { jsonResponse, parseBody } from "../services/http-handler.mjs";
import { updateTenantCampaignPayout } from "../services/campaign-actions.mjs";
import { requireTenantId } from "../services/identity.mjs";
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
  app.patch("/campaigns/:campaignId/payout", async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    const fields = validatePayoutPayload(parseBody(event), { partial: true });
    const updated = await updateTenantCampaignPayout(tenantId, campaignId, fields);
    return jsonResponse(200, formatCampaign(updated));
  });
}