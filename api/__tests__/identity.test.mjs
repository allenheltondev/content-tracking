import { requireTenantId } from "../services/identity.mjs";

const cognitoEvent = (sub) => ({ requestContext: { authorizer: { authSource: "cognito", sub } } });

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
