// HMAC signing key for extension pairing tokens. Provisioned as a
// CFN Parameter (NoEcho) sourced from the EXTENSION_TOKEN_SIGNING_KEY
// GitHub secret, threaded through Globals.Function.Environment so both
// the API Lambda (mint) and the authorizer Lambda (verify) see the
// same value. Rotation: change the GitHub secret and redeploy; every
// minted token becomes invalid (no kid-based acceptance window yet).

const SIGNING_KEY = process.env.EXTENSION_TOKEN_SIGNING_KEY;

export function getExtensionSigningSecret() {
  if (!SIGNING_KEY) {
    throw new Error("EXTENSION_TOKEN_SIGNING_KEY env var is not set.");
  }
  return SIGNING_KEY;
}
