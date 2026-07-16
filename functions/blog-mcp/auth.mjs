import { createHmac, timingSafeEqual } from "node:crypto";

// Verifies the authority-minted identity token the shared RSC agent runtime
// forwards to this MCP server (rsc-core issue #197). The runtime is a "dumb
// courier": it copies the token verbatim onto an outbound header on every MCP
// request and never interprets it. This server holds the same secret Booked used
// to MINT the token (when it created the agent session), so it can trust the
// identity the token claims.
//
// Token shape (matches the @readysetcloud/agent authHeader contract):
//
//   base64url(JSON.stringify(payload)) + "." + base64url(HMAC_SHA256(secret, payloadB64))
//
// payload = { sub, sessionId, version, iat? }. `sub` is the verified Cognito
// user; in Booked `sub` IS the tenant, so it becomes the retrieval `tenantId`.
//
// Trust model (stated plainly): the HMAC proves "Booked's authority minted this
// for user <sub>". It does not cryptographically prove the presenter is the RSC
// runtime — that is acceptable because the token is bound to a `sessionId`, is
// revocable by bumping `version`, and only ever grants a read of the owner's own
// content. The Function URL is public (AuthType NONE), so this token is the
// actual gate; an unsigned/invalid request is rejected before any retrieval.

const b64urlToBuffer = (s) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * Verifies a token against `secret` and the set of accepted `versions`.
 * Returns the decoded payload `{ sub, sessionId, version, iat? }` on success,
 * or `null` on any failure (missing/malformed/bad signature/rejected version) —
 * callers treat null as unauthorized without leaking which check failed.
 */
export function verifyAuthToken(token, { secret, versions }) {
  if (!token || !secret) return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  // Constant-time HMAC comparison.
  const expected = createHmac("sha256", secret).update(payloadB64).digest();
  let given;
  try {
    given = b64urlToBuffer(sigB64);
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(b64urlToBuffer(payloadB64).toString("utf8"));
  } catch {
    return null;
  }

  if (!payload || typeof payload.sub !== "string" || !payload.sub) return null;

  // Version gate: an authority revokes outstanding tokens by bumping the minted
  // `version` and dropping the old one from the accepted set (env), without
  // rotating the shared secret.
  if (versions && versions.length > 0) {
    const v = String(payload.version ?? "");
    if (!versions.includes(v)) return null;
  }

  return payload;
}
