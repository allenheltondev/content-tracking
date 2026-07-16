import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { logger } from "../../api/services/logger.mjs";
import { verifyAuthToken } from "./auth.mjs";
import { buildServer } from "./server.mjs";

// A Booked-hosted MCP server exposing `search_blog`, called by the shared RSC
// agent runtime to ground answers in the author's own content (rsc-core issues
// #196/#197). Hosted on a Lambda Function URL (AuthType NONE); the actual gate is
// the authority-minted identity token the runtime forwards — verified here, and
// the verified `sub` becomes the retrieval tenant (see auth.mjs / server.mjs).
//
// Transport: the MCP SDK's Web-Standard Streamable-HTTP transport (Fetch
// Request/Response), stateless with JSON responses — a clean fit for a buffered
// Function URL, and wire-compatible with the runtime's MCP client (which is the
// same @modelcontextprotocol/sdk).

const AUTH_HEADER = (process.env.MCP_AUTH_HEADER || "x-booked-auth").toLowerCase();

const acceptedVersions = () =>
  (process.env.MCP_AUTH_VERSIONS || "1")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

/** Function URL (payload v2) event → Fetch Request. */
function toRequest(event) {
  const method = event.requestContext?.http?.method ?? "POST";
  const host = event.headers?.host ?? "mcp.local";
  const path = event.rawPath ?? "/";
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : "";

  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (v != null) headers.set(k, v);
  }

  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody
    ? (event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64") : (event.body ?? ""))
    : undefined;

  return new Request(`https://${host}${path}${qs}`, { method, headers, body });
}

/** Fetch Response → Function URL result. */
async function toResult(response) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await response.text();
  return { statusCode: response.status, headers, body };
}

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj),
});

export const handler = async (event) => {
  const request = toRequest(event);

  // Gate every request on the forwarded identity token. Even initialize/tools-list
  // require it — an unsigned caller learns nothing about this server.
  const payload = verifyAuthToken(request.headers.get(AUTH_HEADER), {
    secret: process.env.MCP_AUTH_SECRET,
    versions: acceptedVersions(),
  });
  if (!payload) {
    logger.warn("Rejected unauthorized MCP request");
    return json(401, { error: "unauthorized" });
  }

  // One server + transport per request, scoped to the verified tenant (sub).
  const server = buildServer(payload.sub);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    const result = await toResult(response); // read body before teardown
    return result;
  } catch (err) {
    logger.error("MCP request failed", { error: err?.message });
    return json(500, { error: "internal_error" });
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
};
