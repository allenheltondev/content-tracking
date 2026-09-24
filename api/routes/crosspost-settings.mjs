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
    const writtenCredentials = Object.keys(credentials).length > 0
      ? await mergeBlogCredentials(tenantId, credentials)
      : undefined;
    const writtenTenant = Object.keys(config).length > 0
      ? await upsertTenant(tenantId, { platforms: config })
      : undefined;

    logger.info("Cross-post settings updated", {
      tokens: Object.fromEntries(
        Object.entries(credentials).map(([p, v]) => [p, v === null ? "cleared" : "set"]),
      ),
      config: Object.keys(config),
    });

    // Report on this save from the values it wrote, never by reading them
    // back. The UI caches this response as the settings state, so a read that
    // lands before the write is visible would show "Needs publication ID" on a
    // save that succeeded, and keep showing it. Only the half this request
    // didn't touch is read, and that read is strong too: another card may have
    // saved it a moment ago.
    return jsonResponse(200, await readReadiness(tenantId, {
      tenant: writtenTenant,
      credentials: writtenCredentials,
    }));
  });
}

// Readiness, with any half the caller already holds used as-is. What has to be
// read is read fresh: credentials past the per-container Powertools cache, and
// the tenant row strongly consistent. The author checks this screen right
// after saving, which is exactly when a stale read says "not set up".
async function readReadiness(tenantId, known = {}) {
  const [tenant, credentials] = await Promise.all([
    known.tenant !== undefined ? known.tenant : getTenant(tenantId, { consistentRead: true }),
    known.credentials !== undefined ? known.credentials : getBlogCredentials(tenantId, { forceFetch: true }),
  ]);
  return describeCrosspostReadiness(tenant, credentials);
}
