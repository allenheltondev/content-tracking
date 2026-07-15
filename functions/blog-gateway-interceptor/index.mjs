import { logger } from "../../api/services/logger.mjs";

// AgentCore Gateway REQUEST interceptor for the blog-search gateway. It is the
// identity bridge: the gateway's Lambda-target contract passes only the tool
// arguments to the target, never the caller's identity, so per-tenant scoping
// would be impossible without this. Configured with `passRequestHeaders: true`
// so we receive the incoming Authorization header.
//
// The gateway has already validated the inbound Cognito JWT (CUSTOM_JWT
// authorizer) before we run, so we decode — not verify — it to read `sub`, then
// OVERWRITE `params.arguments._callerSub` with that verified value. Overwrite
// (never merge-if-absent) so a model-supplied `_callerSub` can't spoof another
// tenant. Non-`tools/call` requests (initialize, tools/list, …) pass through
// unchanged.
//
// Security: never log the token or its claims (AgentCore guidance). Idempotent —
// the gateway may retry.

export const handler = async (event) => {
  const gatewayRequest = event?.mcp?.gatewayRequest ?? {};
  const body = gatewayRequest.body ?? {};

  if (body.method !== "tools/call") {
    return passthrough(body);
  }

  const sub = subjectFromHeaders(gatewayRequest.headers);
  if (!sub) {
    // No identity we can trust. Leave `_callerSub` unset — the target fails
    // closed rather than running an unscoped search.
    logger.warn("blog-gateway-interceptor: no sub in request headers");
    return passthrough(body);
  }

  const params = body.params ?? {};
  const transformed = {
    ...body,
    params: {
      ...params,
      arguments: { ...(params.arguments ?? {}), _callerSub: sub },
    },
  };
  return passthrough(transformed);
}

// Decodes (does not verify — the gateway already validated) the Cognito JWT from
// the Authorization header and returns its `sub`, or null.
function subjectFromHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  const key = Object.keys(headers).find((h) => h.toLowerCase() === "authorization");
  const raw = key ? headers[key] : undefined;
  if (typeof raw !== "string" || !raw) return null;

  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64urlDecode(parts[1]));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

function base64urlDecode(input) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function passthrough(body) {
  return {
    interceptorOutputVersion: "1.0",
    mcp: { transformedGatewayRequest: { body } },
  };
}
