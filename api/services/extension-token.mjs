import { createHmac, randomBytes } from "node:crypto";

// JWT-shaped HMAC-SHA256 tokens minted by POST /extensions/pairings and
// pasted into the Chrome extension. The authorizer validates the
// signature, then confirms the jti still exists in DynamoDB so revocation
// from the dashboard takes effect on the next call.
//
// We hand-roll the encode/verify rather than pulling in a JWT library
// because we never accept tokens from outside our own mint and the
// format only ever needs HS256.

const HEADER = { alg: "HS256", typ: "JWT", kid: "v1" };
const ENCODED_HEADER = base64urlEncode(JSON.stringify(HEADER));

export const TOKEN_KID = HEADER.kid;

export function newJti() {
  // 128 bits of entropy, base64url-encoded (22 chars, no padding). Doubles
  // as the DynamoDB sk suffix so the revocation lookup is O(1).
  return base64urlEncode(randomBytes(16));
}

export function signToken({ sub, jti, secret, issuedAt }) {
  if (!sub || !jti || !secret) {
    throw new Error("signToken requires sub, jti, and secret.");
  }
  const payload = {
    sub,
    jti,
    iat: issuedAt ?? Math.floor(Date.now() / 1000),
  };
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${ENCODED_HEADER}.${encodedPayload}`;
  const signature = hmacSign(signingInput, secret);
  return `${signingInput}.${signature}`;
}

// Returns { sub, jti, iat } on success; throws Error on tampered or
// malformed input. Callers separately confirm the jti hasn't been
// revoked (DynamoDB lookup).
export function verifyToken(token, secret) {
  if (typeof token !== "string" || !secret) {
    throw new Error("verifyToken requires a token string and secret.");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed token: expected 3 segments.");
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
    throw new Error(`Token JSON parse failed: ${err.message}`);
  }

  if (header.alg !== "HS256") {
    throw new Error(`Unexpected alg: ${header.alg}`);
  }
  if (!payload.sub || !payload.jti) {
    throw new Error("Token payload missing sub or jti.");
  }
  return { sub: payload.sub, jti: payload.jti, iat: payload.iat };
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

// Constant-time string compare. Buffer.compare and === both short-circuit
// on first byte difference, leaking timing info that lets an attacker
// brute-force a signature byte-by-byte. The XOR loop runs through every
// byte unconditionally.
function timingSafeEqualStrings(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
