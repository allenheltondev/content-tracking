import { BadRequestError } from "../services/errors.mjs";
import { emptyResponse, jsonResponse } from "../services/http-handler.mjs";
import { logger } from "../services/logger.mjs";
import {
  listPairings,
  mintPairing,
  revokePairing,
} from "../domain/extension-pairing.mjs";
import { getExtensionSigningSecret } from "../services/extension-secret.mjs";
import { requireTenantId } from "../services/identity.mjs";

// API keys for automation. These ride the same HMAC-token machinery as the
// Chrome-extension pairings (mint here, verify in api/authorizer.mjs, revoke
// by deleting the row) but are tagged source="apikey", so the authorizer
// stamps authSource="apikey". That lets the content *publish* endpoints
// (requirePublisherTenantId) accept an automated caller — e.g. a GitHub
// Actions hook that registers a blog when the writing repo publishes it —
// while the rest of the API stays dashboard-only.
//
// Minting requires a Cognito-authenticated dashboard user (requireTenantId's
// cognito-only gate), so an API key can never mint more keys for itself. The
// key value is returned exactly once at mint time; store it as a secret in
// the writing repo.

const LABEL_MAX = 60;
const DEFAULT_LABEL = "API key";
const SOURCE = "apikey";

export function registerApiKeyRoutes(app) {
  app.post("/api-keys", async ({ event }) => {
    const sub = requireTenantId(event);
    const label = parseLabel(event) ?? DEFAULT_LABEL;

    const secret = getExtensionSigningSecret();
    const { pairing, token } = await mintPairing({
      sub,
      label,
      signingSecret: secret,
      source: SOURCE,
    });

    logger.info("API key minted", { sub, jti: pairing.jti, label: pairing.label });

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

function parseLabel(event) {
  if (!event.body) return null;
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
  if (body.label === undefined || body.label === null) {
    return null;
  }
  if (typeof body.label !== "string") {
    throw new BadRequestError("label must be a string");
  }
  const trimmed = body.label.trim();
  if (trimmed.length > LABEL_MAX) {
    throw new BadRequestError(`label must be ${LABEL_MAX} characters or fewer`);
  }
  return trimmed;
}
