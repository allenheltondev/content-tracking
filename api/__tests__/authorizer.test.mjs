import { jest } from "@jest/globals";

// The authorizer builds a Cognito verifier at import time, so these must be
// set before the dynamic import below.
process.env.USER_POOL_ID = "us-east-1_Test";
process.env.USER_POOL_CLIENT_ID = "test-client";

const verifyMock = jest.fn();
jest.unstable_mockModule("aws-jwt-verify", () => ({
  CognitoJwtVerifier: { create: () => ({ verify: verifyMock }) },
}));
jest.unstable_mockModule("../domain/extension-pairing.mjs", () => ({
  touchPairing: jest.fn(),
}));
jest.unstable_mockModule("../services/extension-secret.mjs", () => ({
  getExtensionSigningSecret: jest.fn(() => "secret"),
}));
jest.unstable_mockModule("../services/extension-token.mjs", () => ({
  verifyToken: jest.fn(),
}));

const { touchPairing } = await import("../domain/extension-pairing.mjs");
const { verifyToken } = await import("../services/extension-token.mjs");
const { handler } = await import("../authorizer.mjs");

const METHOD_ARN = "arn:aws:execute-api:us-east-1:123:abc/v1/POST/blogs";

// base64url header advertising HS256, so the authorizer routes the token down
// the HMAC path (looksLikeJwt). The payload/signature are placeholders because
// verifyToken is mocked.
function hmacToken() {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${header}.cGF5bG9hZA.c2ln`;
}

beforeEach(() => jest.clearAllMocks());

describe("authorizer HMAC path", () => {
  test("stamps authSource from the pairing's source (apikey)", async () => {
    verifyToken.mockReturnValue({ sub: "user-1", jti: "J1" });
    touchPairing.mockResolvedValue({ jti: "J1", source: "apikey" });

    const res = await handler({ authorizationToken: `Bearer ${hmacToken()}`, methodArn: METHOD_ARN });

    expect(res.context).toEqual({ sub: "user-1", authSource: "apikey", jti: "J1" });
    expect(res.policyDocument.Statement[0].Effect).toBe("Allow");
  });

  test("treats a sourceless (legacy) pairing as an extension token", async () => {
    verifyToken.mockReturnValue({ sub: "user-1", jti: "J1" });
    touchPairing.mockResolvedValue({ jti: "J1" });

    const res = await handler({ authorizationToken: hmacToken(), methodArn: METHOD_ARN });

    expect(res.context.authSource).toBe("extension");
  });

  test("rejects a revoked token (touchPairing returns null)", async () => {
    verifyToken.mockReturnValue({ sub: "user-1", jti: "gone" });
    touchPairing.mockResolvedValue(null);

    await expect(
      handler({ authorizationToken: hmacToken(), methodArn: METHOD_ARN }),
    ).rejects.toThrow(/Unauthorized/);
  });

  test("rejects a missing token", async () => {
    await expect(handler({ authorizationToken: "", methodArn: METHOD_ARN })).rejects.toThrow(/Unauthorized/);
  });
});

describe("authorizer Cognito path", () => {
  test("stamps authSource=cognito for a verified id token", async () => {
    verifyMock.mockResolvedValue({ sub: "user-9" });

    // No HS256 header → falls through to the Cognito verifier.
    const res = await handler({ authorizationToken: "not-a-jwt", methodArn: METHOD_ARN });

    expect(res.context).toEqual({ sub: "user-9", authSource: "cognito" });
  });
});
