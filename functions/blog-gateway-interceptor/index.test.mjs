import { handler } from "./index.mjs";

const SUB = "user-1";

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// A JWT-shaped token (signature is irrelevant — the gateway validates before
// the interceptor runs; the interceptor only decodes).
function jwt(claims) {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.sig`;
}

function requestEvent(body, { authorization } = {}) {
  return {
    mcp: {
      gatewayRequest: {
        body,
        headers: authorization ? { Authorization: authorization } : {},
      },
    },
  };
}

const toolCall = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "blog___search_blog", arguments: { query: "hi" } } };

describe("blog-gateway-interceptor", () => {
  test("injects the verified sub into tools/call arguments", async () => {
    const out = await handler(requestEvent(toolCall, { authorization: `Bearer ${jwt({ sub: SUB })}` }));

    expect(out.interceptorOutputVersion).toBe("1.0");
    const body = out.mcp.transformedGatewayRequest.body;
    expect(body.params.arguments._callerSub).toBe(SUB);
    expect(body.params.arguments.query).toBe("hi"); // original args preserved
  });

  test("overwrites a model-supplied _callerSub (no spoofing)", async () => {
    const spoofed = { ...toolCall, params: { ...toolCall.params, arguments: { query: "hi", _callerSub: "attacker" } } };
    const out = await handler(requestEvent(spoofed, { authorization: `Bearer ${jwt({ sub: SUB })}` }));
    expect(out.mcp.transformedGatewayRequest.body.params.arguments._callerSub).toBe(SUB);
  });

  test("passes non-tools/call requests through unchanged", async () => {
    const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: {} };
    const out = await handler(requestEvent(init, { authorization: `Bearer ${jwt({ sub: SUB })}` }));
    expect(out.mcp.transformedGatewayRequest.body).toEqual(init);
  });

  test("leaves _callerSub unset when no usable token is present (target fails closed)", async () => {
    const out = await handler(requestEvent(toolCall));
    expect(out.mcp.transformedGatewayRequest.body.params.arguments._callerSub).toBeUndefined();
  });
});
