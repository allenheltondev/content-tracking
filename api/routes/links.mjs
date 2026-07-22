import { emptyResponse, jsonResponse, parseBody } from "../services/http-handler.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { formatLink, validateLinkCreate, validateLinkUpdate } from "../validation/link.mjs";
import { createLink, deleteLink, updateLink } from "../domain/link.mjs";
import { assertCampaignOwned } from "../domain/campaign.mjs";
import { requireTenantId } from "../services/identity.mjs";

export function registerLinkRoutes(app) {
  app.post("/campaigns/:campaignId/links", withIdempotency(async ({ event, params }) => {
    const { campaignId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const fields = validateLinkCreate(parseBody(event));
    const item = await createLink(campaignId, fields);
    return jsonResponse(201, formatLink(item, { includeCampaignId: true }));
  }));

  app.put("/campaigns/:campaignId/links/:linkId", async ({ event, params }) => {
    const { campaignId, linkId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    const fields = validateLinkUpdate(parseBody(event));
    const updated = await updateLink(campaignId, linkId, fields);
    return jsonResponse(200, formatLink(updated, { includeCampaignId: true }));
  });

  app.delete("/campaigns/:campaignId/links/:linkId", async ({ event, params }) => {
    const { campaignId, linkId } = params;
    const tenantId = requireTenantId(event);
    await assertCampaignOwned(campaignId, tenantId);
    await deleteLink(campaignId, linkId);
    return emptyResponse(204);
  });
}