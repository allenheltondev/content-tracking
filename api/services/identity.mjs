import { UnauthorizedError } from "./errors.mjs";

// Resolves the calling tenant from the authorizer context. The tenantId
// is the Cognito `sub` the Lambda authorizer already verified; it is
// never read from the request body or path, which is what makes the
// tenant-partitioned data model (pk=TENANT#{tenantId}) safe — a caller
// cannot ask for another tenant's data because they cannot choose the
// tenantId.
//
// Blog and tenant management endpoints require dashboard sign-in
// (authSource = "cognito"); extension (HMAC) callers are rejected.
export function requireTenantId(event) {
  const auth = event?.requestContext?.authorizer ?? {};
  if (auth.authSource !== "cognito") {
    throw new UnauthorizedError("This endpoint requires dashboard sign-in.");
  }
  if (!auth.sub) {
    throw new UnauthorizedError("Missing caller identity.");
  }
  return auth.sub;
}

// Resolves the calling tenant from EITHER auth path — the dashboard (Cognito)
// or the Chrome extension (HMAC pairing token). Both carry the same Cognito
// `sub`, so this is the identity to scope shared data (campaigns/vendors) by on
// endpoints the extension is allowed to hit (e.g. the working-set feeds), where
// requireTenantId's cognito-only gate would wrongly reject the extension.
export function resolveTenantId(event) {
  const auth = event?.requestContext?.authorizer ?? {};
  if (!auth.sub) {
    throw new UnauthorizedError("Missing caller identity.");
  }
  return auth.sub;
}

// Resolves the calling tenant for content *publish* endpoints, which a human
// on the dashboard (authSource="cognito") OR an automation API key
// (authSource="apikey") may call — e.g. a GitHub Actions hook that registers a
// blog on publish. The Chrome extension (authSource="extension") is
// deliberately excluded: its tokens are scoped to the working-set feeds, not
// content creation. Like requireTenantId, the sub is read only from the
// verified authorizer context, so an API key can only ever write into its own
// tenant partition.
export function requirePublisherTenantId(event) {
  const auth = event?.requestContext?.authorizer ?? {};
  if (auth.authSource !== "cognito" && auth.authSource !== "apikey") {
    throw new UnauthorizedError("This endpoint requires dashboard sign-in or an API key.");
  }
  if (!auth.sub) {
    throw new UnauthorizedError("Missing caller identity.");
  }
  return auth.sub;
}
