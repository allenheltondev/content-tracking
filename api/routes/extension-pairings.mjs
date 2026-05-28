import { BadRequestError, UnauthorizedError } from "../services/errors.mjs";
import { emptyResponse, jsonResponse } from "../services/http-handler.mjs";
import { logger } from "../services/logger.mjs";
import {
  listPairings,
  mintPairing,
  revokePairing,
} from "../domain/extension-pairing.mjs";
import { getExtensionSigningSecret } from "../services/extension-secret.mjs";

// Pairing tokens for the Chrome extension. The dashboard mints one on
// Settings → Extension, the user pastes it into the extension's Options.
// The mint route requires a Cognito-authenticated caller (we don't let
// extensions mint more tokens for themselves); list and revoke are
// per-user.
//
// Caller identity comes out of the authorizer context, set by the Lambda
// authorizer in api/authorizer.mjs.

const LABEL_MAX = 60;

export function registerExtensionPairingRoutes(app) {
  app.post("/extensions/pairings", async ({ event }) => {
    const sub = requireCognitoSub(event);
    const label = parseLabel(event);

    const secret = getExtensionSigningSecret();
    const { pairing, token } = await mintPairing({ sub, label, signingSecret: secret });

    logger.info("Extension pairing minted", { sub, jti: pairing.jti, label: pairing.label });

    // 201 + the token in the body. This is the only time the token value
    // ever leaves our side; the dashboard shows it in a one-time dialog.
    return jsonResponse(201, { pairing, token });
  });

  app.get("/extensions/pairings", async ({ event }) => {
    const sub = requireCognitoSub(event);
    const pairings = await listPairings({ sub });
    return jsonResponse(200, { pairings });
  });

  app.delete("/extensions/pairings/:jti", async ({ event, params }) => {
    const sub = requireCognitoSub(event);
    await revokePairing({ sub, jti: params.jti });
    logger.info("Extension pairing revoked", { sub, jti: params.jti });
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

// The mint/list/revoke routes only make sense for a human signed in to
// the dashboard. Extension callers (HMAC tokens) get a different sub
// shape in the authorizer context (sub set, source = "extension"); we
// gate on the auth source so a stolen pairing token can't be used to
// mint more pairings for itself.
function requireCognitoSub(event) {
  const auth = event?.requestContext?.authorizer ?? {};
  if (auth.authSource !== "cognito") {
    throw new UnauthorizedError("This endpoint requires dashboard sign-in.");
  }
  if (!auth.sub) {
    throw new UnauthorizedError("Missing caller identity.");
  }
  return auth.sub;
}
