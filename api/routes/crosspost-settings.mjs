import { jsonResponse, parseBody } from "../services/http-handler.mjs";
import { logger } from "../services/logger.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { getTenant, upsertTenant } from "../domain/tenant.mjs";
import { getBlogCredentials, mergeBlogCredentials } from "../services/blog-credentials.mjs";
import { describeCrosspostReadiness } from "../services/crosspost-readiness.mjs";
import { validateCrosspostSettings } from "../validation/crosspost-settings.mjs";

// Cross-post platform setup: whether each of dev.to / Medium / Hashnode can
// publish, and a way to fix it when it can't. The content page reads GET to
// decide whether "Cross-post for me" is available per platform; the Settings
// "Cross-posting" tab reads and writes it.
//
// Dashboard-only (requireTenantId), deliberately narrower than cross-posting
// itself (requirePublisherTenantId): an API key can publish, but it must not
// be able to rewrite the tokens it publishes with.
//
// Tokens are write-only. Neither response ever contains one — the readiness
// report carries `token_configured` and nothing else about it.

export function registerCrosspostSettingsRoutes(app) {
  app.get("/settings/crosspost", async ({ event }) => {
    const tenantId = requireTenantId(event);
    return jsonResponse(200, await readReadiness(tenantId));
  });

  app.put("/settings/crosspost", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const { credentials, config } = validateCrosspostSettings(parseBody(event));

    // Credentials first: they're the half that can fail on an SSM/KMS error,
    // and a failed save should not leave the ids updated with the token not.
    if (Object.keys(credentials).length > 0) {
      await mergeBlogCredentials(tenantId, credentials);
    }
    if (Object.keys(config).length > 0) {
      await upsertTenant(tenantId, { platforms: config });
    }

    logger.info("Cross-post settings updated", {
      tokens: Object.fromEntries(
        Object.entries(credentials).map(([p, v]) => [p, v === null ? "cleared" : "set"]),
      ),
      config: Object.keys(config),
    });

    return jsonResponse(200, await readReadiness(tenantId));
  });
}

// Forced past the Powertools cache. Credentials cache per Lambda container, so
// after a save a warm container could keep reporting "not set up" for up to
// five minutes — which is exactly the moment the author comes back to check.
async function readReadiness(tenantId) {
  const [tenant, credentials] = await Promise.all([
    getTenant(tenantId),
    getBlogCredentials(tenantId, { forceFetch: true }),
  ]);
  return describeCrosspostReadiness(tenant, credentials);
}
