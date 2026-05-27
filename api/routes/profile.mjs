import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { logger } from "../services/logger.mjs";
import { validateProfileUpdate } from "../validation/profile.mjs";
import { getProfileSettings, saveProfileSettings } from "../domain/profile.mjs";
import {
  readCruxApiKey,
  readGa4ServiceAccount,
  writeCruxApiKey,
  writeGa4ServiceAccount,
} from "../services/ga-secrets.mjs";

// Account-level integration settings: the GA4 property + service account
// and the CrUX/PageSpeed API key. Secrets are never echoed back — responses
// only report whether each integration is configured.

export function registerProfileRoutes(app) {
  app.get("/profile", async () => {
    return jsonResponse(200, await buildProfileView());
  });

  app.put("/profile", async ({ event }) => {
    const fields = validateProfileUpdate(parseBody(event));

    if (fields.ga4ServiceAccount) {
      await writeGa4ServiceAccount(fields.ga4ServiceAccount);
    }
    if (fields.cruxApiKey) {
      await writeCruxApiKey(fields.cruxApiKey);
    }
    if (fields.ga4PropertyId) {
      await saveProfileSettings({ ga4PropertyId: fields.ga4PropertyId });
    }

    logger.info("Profile settings updated", {
      ga4PropertyId: fields.ga4PropertyId ? "set" : "unchanged",
      ga4ServiceAccount: fields.ga4ServiceAccount ? "set" : "unchanged",
      cruxApiKey: fields.cruxApiKey ? "set" : "unchanged",
    });

    // forceFetch so the response reflects the just-written secrets rather
    // than Powertools' 5-minute cache.
    return jsonResponse(200, await buildProfileView({ forceFetch: true }));
  });
}

async function buildProfileView({ forceFetch = false } = {}) {
  const [settings, serviceAccount, cruxKey] = await Promise.all([
    getProfileSettings(),
    readGa4ServiceAccount({ forceFetch }),
    readCruxApiKey({ forceFetch }),
  ]);

  return {
    ga4: {
      property_id: settings?.ga4PropertyId ?? null,
      service_account_email: serviceAccount?.client_email ?? null,
      configured: Boolean(settings?.ga4PropertyId && serviceAccount),
    },
    core_web_vitals: {
      configured: Boolean(cruxKey),
    },
    updated_at: settings?.updatedAt ?? null,
  };
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
