import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse, parseBody } from "../services/http-handler.mjs";
import { assertCampaignOwned, updateCampaignPayout } from "../domain/campaign.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { applyPaidAtDefault, formatPayout, validatePayoutPayload } from "../validation/payout.mjs";

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
    await assertCampaignOwned(campaignId, tenantId);
    const body = parseBody(event);
    const fields = validatePayoutPayload(body, { partial: true });

    if (Object.keys(fields).length === 0) {
      throw new BadRequestError("request body must contain at least one payout field");
    }

    applyPaidAtDefault(fields);

    const updated = await updateCampaignPayout(campaignId, fields);
    return jsonResponse(200, formatCampaign(updated));
  });
}