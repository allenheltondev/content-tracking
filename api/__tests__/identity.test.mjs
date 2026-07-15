import { requirePublisherTenantId, requireTenantId } from "../services/identity.mjs";

const cognitoEvent = (sub) => ({ requestContext: { authorizer: { authSource: "cognito", sub } } });
const authEvent = (authSource, sub) => ({ requestContext: { authorizer: { authSource, sub } } });

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
