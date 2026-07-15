import { CognitoJwtVerifier } from "aws-jwt-verify";
import { touchPairing } from "./domain/extension-pairing.mjs";
import { getExtensionSigningSecret } from "./services/extension-secret.mjs";
import { verifyToken } from "./services/extension-token.mjs";
import { logger } from "./services/logger.mjs";

// Lambda TOKEN authorizer for the API. Accepts either:
//   - a Cognito id token (dashboard sign-in) — verified via JWKS
//   - an HMAC-SHA256 API token (Chrome extension or CI) — verified against
//     the signing secret, then a DynamoDB write confirms the jti hasn't been
//     revoked. The persisted row carries the token's source ("extension" or
//     "ci"), which becomes context.authSource.
//
// Returns an IAM policy plus a context object the routes read via
// event.requestContext.authorizer to know who the caller is and which
// auth path they came in on. Routes gate on context.authSource — human-only
// endpoints require "cognito"; publish endpoints also accept "ci".

const USER_POOL_ID = process.env.USER_POOL_ID;
const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID;

if (!USER_POOL_ID || !USER_POOL_CLIENT_ID) {
  throw new Error("USER_POOL_ID and USER_POOL_CLIENT_ID env vars must be set.");
}

// Module-scope so JWKS stays cached across invocations in the same
// execution environment. The verifier holds the JWKS internally.
const cognitoVerifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: "id",
  clientId: USER_POOL_CLIENT_ID,
});

export async function handler(event) {
  const raw = event?.authorizationToken ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();

  if (!token) {
    logger.info("Authorizer: missing token");
    throw new Error("Unauthorized");
  }

  const methodArn = event.methodArn;

  try {
    if (looksLikeJwt(token, "HS256")) {
      return await authorizeHmacToken(token, methodArn);
    }
    // Default: treat as a Cognito id token. Catches RS256, ES256, or any
    // shape we didn't issue ourselves — let the Cognito verifier reject
    // it if it's not actually a Cognito token.
    return await authorizeCognitoToken(token, methodArn);
  } catch (err) {
    // API Gateway only treats a thrown "Unauthorized" Error as a 401;
    // anything else becomes a 500. Convert all auth failures into the
    // canonical message but log details for ops.
    logger.info("Authorizer: rejecting token", { reason: err?.message });
    throw new Error("Unauthorized", { cause: err });
  }
}

async function authorizeCognitoToken(token, methodArn) {
  const payload = await cognitoVerifier.verify(token);
  return allow({
    principalId: payload.sub,
    methodArn,
    context: { sub: payload.sub, authSource: "cognito" },
  });
}

async function authorizeHmacToken(token, methodArn) {
  const secret = getExtensionSigningSecret();
  const { sub, jti } = verifyToken(token, secret);

  // Revocation check + last_used_at bump in a single conditional update.
  // The dashboard's DELETE removes this item, so a revoked token fails
  // the attribute_exists guard here even though its signature still
  // matches. The returned row also tells us the token's source.
  const pairing = await touchPairing({ sub, jti });
  if (!pairing) {
    throw new Error("Token has been revoked.");
  }

  // Source lives on the persisted row, not the token, so the same signed
  // shape covers both flavours. Rows minted before the tag existed are
  // treated as extension tokens.
  return allow({
    principalId: sub,
    methodArn,
    context: { sub, authSource: pairing.source ?? "extension", jti },
  });
}

// Decodes only the header — used to dispatch which verification path to
// run. Cheap and safe (we still verify the signature below).
function looksLikeJwt(token, expectedAlg) {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const headerJson = Buffer.from(
      parts[0].replace(/-/g, "+").replace(/_/g, "/") +
        "===".slice((parts[0].length + 3) % 4),
      "base64",
    ).toString("utf8");
    const header = JSON.parse(headerJson);
    return header.alg === expectedAlg;
  } catch {
    return false;
  }
}

function allow({ principalId, methodArn, context }) {
  return {
    principalId,
    // Wildcard so the cached authorizer response works across every
    // method/path the same caller hits within the cache TTL. The
    // cache key is the token itself; the policy resource just needs
    // to permit anything on the API.
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: "Allow",
          Resource: methodArnWildcard(methodArn),
        },
      ],
    },
    context,
  };
}

// methodArn looks like arn:aws:execute-api:us-east-1:123:abc/v1/GET/foo
// Replace the stage + method + path with /*/*/* so one cached policy
// covers every request that reuses the same authorizer cache entry.
function methodArnWildcard(methodArn) {
  if (!methodArn) return "*";
  const parts = methodArn.split(":");
  if (parts.length < 6) return methodArn;
  const apiAndPath = parts[5];
  const apiId = apiAndPath.split("/")[0];
  parts[5] = `${apiId}/*/*/*`;
  return parts.join(":");
}
