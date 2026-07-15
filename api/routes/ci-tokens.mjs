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

// CI / automation tokens. These ride the same HMAC-token machinery as the
// Chrome-extension pairings (mint here, verify in api/authorizer.mjs, revoke
// by deleting the row) but are tagged source="ci", so the authorizer stamps
// authSource="ci". That lets the content *publish* endpoints
// (requirePublisherTenantId) accept an automated caller — e.g. a GitHub
// Actions hook that registers a blog when the writing repo publishes it —
// while the rest of the API stays dashboard-only.
//
// Minting requires a Cognito-authenticated dashboard user (requireTenantId's
// cognito-only gate), so a CI token can never mint more tokens for itself. The
// token value is returned exactly once at mint time; store it as a secret in
// the writing repo.

const LABEL_MAX = 60;
const DEFAULT_LABEL = "CI token";

export function registerCiTokenRoutes(app) {
  app.post("/ci/tokens", async ({ event }) => {
    const sub = requireTenantId(event);
    const label = parseLabel(event) ?? DEFAULT_LABEL;

    const secret = getExtensionSigningSecret();
    const { pairing, token } = await mintPairing({
      sub,
      label,
      signingSecret: secret,
      source: "ci",
    });

    logger.info("CI token minted", { sub, jti: pairing.jti, label: pairing.label });

    // 201 + the token in the body. This is the only time the token value ever
    // leaves our side; the dashboard shows it in a one-time dialog.
    return jsonResponse(201, { token, ...pairing });
  });

  app.get("/ci/tokens", async ({ event }) => {
    const sub = requireTenantId(event);
    const tokens = await listPairings({ sub, source: "ci" });
    return jsonResponse(200, { tokens });
  });

  app.delete("/ci/tokens/:jti", async ({ event, params }) => {
    const sub = requireTenantId(event);
    await revokePairing({ sub, jti: params.jti });
    logger.info("CI token revoked", { sub, jti: params.jti });
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
