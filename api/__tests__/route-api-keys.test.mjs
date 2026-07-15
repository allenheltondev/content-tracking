import { jest } from "@jest/globals";

jest.unstable_mockModule("../domain/extension-pairing.mjs", () => ({
  mintPairing: jest.fn(),
  listPairings: jest.fn(),
  revokePairing: jest.fn(),
}));
jest.unstable_mockModule("../services/extension-secret.mjs", () => ({
  getExtensionSigningSecret: jest.fn(() => "test-signing-secret-32-chars-long-xx"),
}));

const { mintPairing, listPairings, revokePairing } = await import("../domain/extension-pairing.mjs");
const { registerApiKeyRoutes } = await import("../routes/api-keys.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    get: (p, h) => { routes[`GET ${p}`] = h; },
    post: (p, h) => { routes[`POST ${p}`] = h; },
    delete: (p, h) => { routes[`DELETE ${p}`] = h; },
  };
  registerApiKeyRoutes(app);
  return routes;
}
const routes = buildRouteTable();
const SUB = "user-1";

function ctx({ authSource = "cognito", sub = SUB, body, params } = {}) {
  return {
    event: {
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: { authorizer: { authSource, sub } },
    },
    params,
  };
}

beforeEach(() => jest.clearAllMocks());

describe("POST /api-keys", () => {
  test("mints an apikey-sourced token for the dashboard caller and returns the key once", async () => {
    mintPairing.mockResolvedValue({
      pairing: { jti: "J1", label: "writing-repo", created_at: "t0", last_used_at: null },
      token: "the.signed.token",
    });

    const res = await routes["POST /api-keys"](ctx({ body: { label: "writing-repo" } }));

    expect(mintPairing).toHaveBeenCalledWith(expect.objectContaining({
      sub: SUB, label: "writing-repo", source: "apikey",
    }));
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.key).toBe("the.signed.token");
    expect(body.jti).toBe("J1");
  });

  test("defaults the label when none is supplied", async () => {
    mintPairing.mockResolvedValue({ pairing: { jti: "J2" }, token: "t" });
    await routes["POST /api-keys"](ctx({}));
    expect(mintPairing).toHaveBeenCalledWith(expect.objectContaining({ label: "API key", source: "apikey" }));
  });

  test("rejects an API key trying to mint another (non-cognito caller)", async () => {
    await expect(routes["POST /api-keys"](ctx({ authSource: "apikey" }))).rejects.toThrow(/dashboard sign-in/);
    expect(mintPairing).not.toHaveBeenCalled();
  });
});

describe("GET /api-keys", () => {
  test("lists only the caller's apikey-sourced tokens", async () => {
    listPairings.mockResolvedValue([{ jti: "J1", label: "writing-repo", created_at: "t", last_used_at: null }]);
    const res = await routes["GET /api-keys"](ctx({}));
    expect(listPairings).toHaveBeenCalledWith({ sub: SUB, source: "apikey" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).keys).toHaveLength(1);
  });
});

describe("DELETE /api-keys/:jti", () => {
  test("revokes the key scoped to the caller", async () => {
    revokePairing.mockResolvedValue(undefined);
    const res = await routes["DELETE /api-keys/:jti"](ctx({ params: { jti: "J1" } }));
    expect(revokePairing).toHaveBeenCalledWith({ sub: SUB, jti: "J1" });
    expect(res.statusCode).toBe(204);
  });
});
