import {
  assertCampaignOwned,
  createCampaign,
  updateCampaignFields,
  updateCampaignPayout,
} from "../domain/campaign.mjs";
import { assertVendorOwned } from "../domain/vendor.mjs";
import {
  AGGREGATION_CURRENCY,
  applyPaidAtDefault,
  validatePayoutPayload,
} from "../validation/payout.mjs";
import { trackActivity } from "./activity.mjs";
import { BadRequestError } from "./errors.mjs";

// Tenant-scoped campaign mutations shared by the REST routes and the MCP
// tools (functions/mcp). Each takes already-validated fields plus the tenant
// resolved from the authorizer, enforces ownership, and returns the stored
// row for the caller to format.

// Creates a campaign for the tenant. A vendor link writes a row under the
// vendor's partition and surfaces in its /vendors/:id/campaigns list, so the
// vendor must be the caller's before we accept it (404s a missing or foreign
// vendor). The "Deal Maker" activity is keyed per campaign so a retried
// request can't double-count.
export async function createTenantCampaign(tenantId, fields) {
  if (fields.vendorId) {
    await assertVendorOwned(fields.vendorId, tenantId);
  }
  const item = await createCampaign({ ...fields, tenantId });
  await trackActivity(tenantId, "campaign.created", {
    id: `campaign.created#${tenantId}#${item.campaignId}`,
  });
  return item;
}

// Moves a campaign to a new status. The status must already be validated
// against the campaign status set.
export async function setCampaignStatus(tenantId, campaignId, status) {
  await assertCampaignOwned(campaignId, tenantId);
  return updateCampaignFields(campaignId, { status });
}

// Marks a campaign's payout as paid. paid_at defaults to today (UTC) when
// omitted; invoice_ref is recorded when supplied. amount and currency are
// only written when supplied, which lets a caller record the fee at the
// same time on a campaign that never had one. A paid payout with no amount
// would count as revenue of nothing, so that case is rejected.
export async function markCampaignPaid(
  tenantId,
  campaignId,
  { paidAt, invoiceRef, amount, currency } = {},
) {
  const fields = validatePayoutPayload(
    {
      paid: true,
      ...(paidAt !== undefined ? { paid_at: paidAt } : {}),
      ...(invoiceRef !== undefined ? { invoice_ref: invoiceRef } : {}),
      ...(amount !== undefined ? { amount } : {}),
      ...(currency !== undefined ? { currency } : {}),
    },
    { partial: true },
  );
  applyPaidAtDefault(fields);
  const campaign = await assertCampaignOwned(campaignId, tenantId);
  if (fields.amount === undefined && typeof campaign.payout?.amount !== "number") {
    throw new BadRequestError("Campaign has no payout amount. Provide amount to record it.");
  }
  if (fields.amount !== undefined && fields.currency === undefined && !campaign.payout?.currency) {
    fields.currency = AGGREGATION_CURRENCY;
  }
  return updateCampaignPayout(campaignId, fields);
}
