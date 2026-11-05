import { createMcpHandler, originValidationResponse } from "@modelcontextprotocol/server";
import { UnauthorizedError } from "../../api/services/errors.mjs";
import { requireAgentTenantId, resolveAccess } from "../../api/services/identity.mjs";
import { logger } from "../../api/services/logger.mjs";
import { publicReportLinkUrl } from "../../api/domain/campaign-report-link.mjs";
import { buildServer } from "./server.mjs";

// The Booked MCP server (POST /mcp on the REST API). Implements the
// 2026-07-28 Streamable HTTP transport statelessly: every request carries
// its own protocol version and capabilities, so each invocation builds a
// fresh server bound to the caller's tenant and answers with plain JSON.
// 2025-era clients that still open with `initialize` are served by the
// SDK's stateless legacy fallback.
//
// Auth: BookedAuthorizer runs first, so the token is already verified.
// Agents such as Muse send an API key as `Authorization: Bearer <key>`;
// requireAgentTenantId accepts that (or a dashboard token) and rejects the
// Chrome extension. No OAuth discovery document is published because API
// keys are minted in the dashboard, not through an authorization server.

const MAX_BODY_BYTES = 1024 * 1024;

// Hostnames allowed to call from a browser. Agents run server-side and send
// no Origin header, so the default (empty) rejects every browser origin,
// which is what the spec's DNS-rebinding guidance asks for.
const ALLOWED_ORIGIN_HOSTS = (process.env.MCP_ALLOWED_ORIGIN_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

// The default "auto" response mode answers with a single JSON body; it only
// upgrades to SSE when a tool emits a mid-call notification, and none do.
const mcp = createMcpHandler(({ authInfo }) => buildServer(authInfo?.extra ?? {}), {
  maxRequestBodySize: MAX_BODY_BYTES,
  onerror: (error) => logger.warn("MCP request rejected", { error: error.message }),
});

export const handler = async (event) => {
  let tenantId;
  try {
    tenantId = requireAgentTenantId(event);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return rpcError(401, err.message);
    }
    throw err;
  }

  const request = toRequest(event);
  const originRejection = originValidationResponse(request, ALLOWED_ORIGIN_HOSTS);
  if (originRejection) {
    return toProxyResult(originRejection);
  }

  const response = await mcp.fetch(request, {
    authInfo: {
      token: "",
      clientId: event.requestContext?.authorizer?.jti ?? "dashboard",
      scopes: [],
      extra: {
        tenantId,
        access: resolveAccess(event),
        // Same host and stage prefix as this request, so report links match
        // the ones the dashboard hands out.
        publicReportUrl: (token) => publicReportLinkUrl(event, token),
      },
    },
  });
  return toProxyResult(response);
};

// API Gateway REST proxy event -> web Request. Multi-value headers keep
// repeated headers intact; the host header rebuilds an absolute URL.
export function toRequest(event) {
  const headers = new Headers();
  for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) {
    for (const value of values ?? []) headers.append(name, value);
  }
  if ([...headers.keys()].length === 0) {
    for (const [name, value] of Object.entries(event.headers ?? {})) {
      if (value !== undefined && value !== null) headers.set(name, value);
    }
  }
  const host = headers.get("host") ?? "localhost";
  const url = `https://${host}${event.path ?? "/mcp"}`;
  const method = event.httpMethod ?? "POST";
  const hasBody = method !== "GET" && method !== "HEAD" && event.body;
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : event.body
    : undefined;
  return new Request(url, { method, headers, body });
}

export async function toProxyResult(response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return { statusCode: response.status, headers, body: await response.text() };
}

function rpcError(statusCode, message) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }),
  };
}
