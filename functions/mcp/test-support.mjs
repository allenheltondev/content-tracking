import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jest } from "@jest/globals";

// Test-only helper (not imported by the handler, so never bundled). Builds a
// jest.unstable_mockModule factory that replaces every exported function of
// a module with jest.fn(), read from the module's own source so the mock
// tracks its export list. Overrides win, for constants or fixed behavior.
export function autoMock(specifier, base, overrides = {}) {
  const file = fileURLToPath(new URL(specifier, base));
  const source = readFileSync(file, "utf8");
  const names = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
  return () => ({ ...Object.fromEntries(names.map((n) => [n, jest.fn()])), ...overrides });
}

export const SUB = "tenant-1";
export const VERSION = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "muse", version: "1.0.0" },
};

// An API Gateway REST proxy event for one JSON-RPC call, as BookedAuthorizer
// would hand it over for an API key.
export function rpcEvent({ method, params = {}, name, headers = {}, authSource = "apikey", body } = {}) {
  const allHeaders = {
    Host: "api.example.com",
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": VERSION,
    "Mcp-Method": method,
    ...(name ? { "Mcp-Name": name } : {}),
    ...headers,
  };
  return {
    httpMethod: "POST",
    path: "/mcp",
    headers: allHeaders,
    multiValueHeaders: Object.fromEntries(Object.entries(allHeaders).map(([k, v]) => [k, [v]])),
    body: body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
    isBase64Encoded: false,
    requestContext: {
      domainName: "api.example.com",
      path: "/v1/mcp",
      authorizer: { authSource, sub: SUB, jti: "key-1" },
    },
  };
}

export function mcpClient(handler) {
  const rpc = async (opts) => {
    const res = await handler(rpcEvent(opts));
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const callTool = async (name, args) => {
    const { body } = await rpc({ method: "tools/call", name, params: { name, arguments: args } });
    return body.result;
  };
  return { rpc, callTool };
}
