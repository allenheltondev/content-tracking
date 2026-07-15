import { createHmac } from "node:crypto";

// A JWT-shaped HMAC-SHA256 "grant" that carries the caller's identity from the
// Booked session-create endpoint (POST /agent/sessions), through the shared
// rsc-core AgentCore runtime, to Booked's own blog-search MCP server. The
// runtime is a generic courier: it stores the grant in the session's mcpServers
// config and forwards it verbatim as an auth header on every MCP call
// (readysetcloud/rsc-core#197). Booked both MINTS this (here) and VERIFIES it
// (in the MCP server), so no secret ever leaves Booked and the runtime never
// signs anything — the "identity forwarding loop" closes on us.
//
// What the grant proves to the MCP server: "Booked minted this for user `sub`."
// Because tenantId === the Cognito sub in this data model (see identity.mjs),
// that sub is also the tenant the MCP server scopes retrieval to. The grant is
// minted only after the API authorizer verified the caller's Cognito id token,
// so the chain of trust is: Cognito JWT -> Booked mint -> MCP verify.
//
// Scope/lifetime: the grant binds `sub` + a key `version` (revocation lever).
// It is stored in the runtime's session-config row and replayed on every
// reconnect over that session's ~30-day life, so it is effectively long-lived —
// there is no short expiry because that would break long-running sessions.
// Rotate `BLOG_MCP_KEY_VERSION` (and the signing key) to invalidate outstanding
// grants. The blast radius of a leaked grant is a read of the owner's OWN blog
// content and nothing else, which makes this posture acceptable; document it
// rather than implying the grant is short-lived.
//
// We hand-roll encode/verify (no JWT library) exactly like the extension
// pairing token (services/extension-token.mjs): we only ever accept grants from
// our own mint and only need HS256.

const HEADER = { alg: "HS256", typ: "JWT", kid: "blog-grant-v1" };
const ENCODED_HEADER = base64urlEncode(JSON.stringify(HEADER));

// The header name the runtime forwards the grant under, and the MCP server
// reads it from. Kept here so mint (Booked) and the McpServerSpec.authHeader.name
// stay in lock-step.
export const BLOG_GRANT_HEADER = "x-booked-agent-auth";

/**
 * Mints a grant for a verified caller. `sub` is the Cognito sub (=== tenantId).
 * `version` is a monotonic revocation lever (default 1); bump it alongside the
 * signing key to invalidate every outstanding grant at once.
 */
export function signBlogGrant({ sub, secret, version = 1, issuedAt }) {
  if (!sub || !secret) {
    throw new Error("signBlogGrant requires sub and secret.");
  }
  const payload = {
    sub,
    ver: version,
    iat: issuedAt ?? Math.floor(Date.now() / 1000),
  };
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${ENCODED_HEADER}.${encodedPayload}`;
  const signature = hmacSign(signingInput, secret);
  return `${signingInput}.${signature}`;
}

/**
 * Verifies a grant and returns { sub, ver, iat }. Throws on a tampered or
 * malformed grant. The caller (the MCP server) additionally enforces that
 * `ver` matches the currently-accepted key version, so a rotated-out grant is
 * rejected even though its signature still checks out.
 */
export function verifyBlogGrant(token, secret) {
  if (typeof token !== "string" || !secret) {
    throw new Error("verifyBlogGrant requires a token string and secret.");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed grant: expected 3 segments.");
  }
  const [encodedHeader, encodedPayload, signature] = parts;

  const expected = hmacSign(`${encodedHeader}.${encodedPayload}`, secret);
  if (!timingSafeEqualStrings(expected, signature)) {
    throw new Error("Signature mismatch.");
  }

  let header;
  let payload;
  try {
    header = JSON.parse(base64urlDecode(encodedHeader));
    payload = JSON.parse(base64urlDecode(encodedPayload));
  } catch (err) {
    throw new Error(`Grant JSON parse failed: ${err.message}`, { cause: err });
  }

  if (header.alg !== "HS256") {
    throw new Error(`Unexpected alg: ${header.alg}`);
  }
  if (!payload.sub) {
    throw new Error("Grant payload missing sub.");
  }
  return { sub: payload.sub, ver: payload.ver, iat: payload.iat };
}

function hmacSign(input, secret) {
  return base64urlEncode(createHmac("sha256", secret).update(input).digest());
}

function base64urlEncode(input) {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

// Constant-time compare (see extension-token.mjs for the rationale): a plain
// === short-circuits on the first differing byte, leaking timing that lets an
// attacker recover a signature byte-by-byte.
function timingSafeEqualStrings(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
