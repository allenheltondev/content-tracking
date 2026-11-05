import {
  requireAgentTenantId,
  requirePublisherTenantId,
  requireTenantId,
  resolveAccess,
} from "../services/identity.mjs";

const cognitoEvent = (sub) => ({ requestContext: { authorizer: { authSource: "cognito", sub } } });
const authEvent = (authSource, sub, access) => ({
  requestContext: { authorizer: { authSource, sub, ...(access === undefined ? {} : { access }) } },
});

describe("services/identity requireTenantId", () => {
  test("returns the Cognito sub as the tenantId", () => {
    expect(requireTenantId(cognitoEvent("sub-abc"))).toBe("sub-abc");
  });

  test("rejects non-cognito (e.g. extension) callers", () => {
    const event = { requestContext: { authorizer: { authSource: "extension", sub: "sub-abc" } } };
    expect(() => requireTenantId(event)).toThrow(/dashboard sign-in/);
  });

  test("rejects a missing sub", () => {
    const event = { requestContext: { authorizer: { authSource: "cognito" } } };
    expect(() => requireTenantId(event)).toThrow(/caller identity/);
  });

  test("rejects a missing authorizer context", () => {
    expect(() => requireTenantId({})).toThrow(/dashboard sign-in/);
  });
});

describe("services/identity requirePublisherTenantId", () => {
  test("returns the sub for a Cognito (dashboard) caller", () => {
    expect(requirePublisherTenantId(authEvent("cognito", "sub-abc"))).toBe("sub-abc");
  });

  test("returns the sub for an API-key caller", () => {
    expect(requirePublisherTenantId(authEvent("apikey", "sub-abc"))).toBe("sub-abc");
  });

  test("rejects the Chrome extension (extension) auth source", () => {
    expect(() => requirePublisherTenantId(authEvent("extension", "sub-abc"))).toThrow(
      /dashboard sign-in or an API key/,
    );
  });

  test("rejects a missing sub even for an allowed source", () => {
    expect(() => requirePublisherTenantId(authEvent("apikey"))).toThrow(/caller identity/);
  });

  test("rejects a missing authorizer context", () => {
    expect(() => requirePublisherTenantId({})).toThrow(/dashboard sign-in or an API key/);
  });
});

describe("services/identity requireAgentTenantId", () => {
  test("returns the sub for an API-key caller", () => {
    expect(requireAgentTenantId(authEvent("apikey", "sub-abc"))).toBe("sub-abc");
  });

  test("returns the sub for a Cognito (dashboard) caller", () => {
    expect(requireAgentTenantId(authEvent("cognito", "sub-abc"))).toBe("sub-abc");
  });

  test("rejects the Chrome extension (extension) auth source", () => {
    expect(() => requireAgentTenantId(authEvent("extension", "sub-abc"))).toThrow(/requires an API key/);
  });

  test("rejects a missing sub even for an allowed source", () => {
    expect(() => requireAgentTenantId(authEvent("apikey"))).toThrow(/caller identity/);
  });
});

describe("services/identity access levels", () => {
  test("a read-only API key cannot publish", () => {
    expect(() => requirePublisherTenantId(authEvent("apikey", "sub-abc", "read"))).toThrow(/read only/);
  });

  test("a write API key and a legacy key with no level can publish", () => {
    expect(requirePublisherTenantId(authEvent("apikey", "sub-abc", "write"))).toBe("sub-abc");
    expect(requirePublisherTenantId(authEvent("apikey", "sub-abc"))).toBe("sub-abc");
  });

  test("a read-only API key can still reach the MCP endpoint", () => {
    expect(requireAgentTenantId(authEvent("apikey", "sub-abc", "read"))).toBe("sub-abc");
  });

  test.each([
    ["cognito", undefined, "write"],
    ["apikey", undefined, "write"],
    ["apikey", "write", "write"],
    ["apikey", "read", "read"],
    ["apikey", "admin", "read"],
    ["extension", undefined, "read"],
  ])("resolveAccess(%s, %s) is %s", (source, access, expected) => {
    expect(resolveAccess(authEvent(source, "sub-abc", access))).toBe(expected);
  });
});
