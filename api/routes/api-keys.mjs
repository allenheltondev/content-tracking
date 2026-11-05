import { emptyResponse, jsonResponse, parseBody } from "../services/http-handler.mjs";
import { logger } from "../services/logger.mjs";
import {
  listPairings,
  mintPairing,
  revokePairing,
} from "../domain/extension-pairing.mjs";
import { getExtensionSigningSecret } from "../services/extension-secret.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { validateApiKeyCreate } from "../validation/api-key.mjs";

// API keys for automation. These ride the same HMAC-token machinery as the
// Chrome-extension pairings (mint here, verify in api/authorizer.mjs, revoke
// by deleting the row) but are tagged source="apikey", so the authorizer
// stamps authSource="apikey". API keys reach the content publish endpoints
// (requirePublisherTenantId) and the MCP server (requireAgentTenantId); the
// rest of the API stays dashboard-only.
//
// Each key carries an access level chosen at mint time: "read" keys get the
// read-only MCP tools and nothing else, "write" keys can also publish and
// change campaigns. The level is fixed for the key's life; mint a new key
// to change it.
//
// Minting requires a Cognito-authenticated dashboard user (requireTenantId's
// cognito-only gate), so an API key can never mint more keys for itself. The
// key value is returned exactly once at mint time.

const DEFAULT_LABEL = "API key";
const SOURCE = "apikey";

export function registerApiKeyRoutes(app) {
  app.post("/api-keys", async ({ event }) => {
    const sub = requireTenantId(event);
    const { label, access } = validateApiKeyCreate(parseBody(event, { optional: true }));

    const secret = getExtensionSigningSecret();
    const { pairing, token } = await mintPairing({
      sub,
      label: label ?? DEFAULT_LABEL,
      signingSecret: secret,
      source: SOURCE,
      access,
    });

    logger.info("API key minted", { sub, jti: pairing.jti, label: pairing.label, access });

    // 201 + the key in the body. This is the only time the key value ever
    // leaves our side; the dashboard shows it in a one-time dialog.
    return jsonResponse(201, { key: token, ...pairing });
  });

  app.get("/api-keys", async ({ event }) => {
    const sub = requireTenantId(event);
    const keys = await listPairings({ sub, source: SOURCE });
    return jsonResponse(200, { keys });
  });

  app.delete("/api-keys/:jti", async ({ event, params }) => {
    const sub = requireTenantId(event);
    await revokePairing({ sub, jti: params.jti });
    logger.info("API key revoked", { sub, jti: params.jti });
    return emptyResponse(204);
  });
}
