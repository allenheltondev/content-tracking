import { getTenant, upsertTenant } from "../domain/tenant.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { BadRequestError } from "../services/errors.mjs";
import { formatTenant, validateTenantConfig } from "../validation/tenant.mjs";

// Per-tenant config (publication targets, canonical base URL, admin
// email). tenantId always comes from the authorizer sub, never the
// request, so a caller can only ever read/write their own config.

export function registerTenantRoutes(app) {
  app.get("/tenant", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const tenant = await getTenant(tenantId);
    return jsonResponse(200, formatTenant(tenant));
  });

  app.put("/tenant", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const config = validateTenantConfig(parseBody(event));
    const item = await upsertTenant(tenantId, config);
    return jsonResponse(200, formatTenant(item));
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
