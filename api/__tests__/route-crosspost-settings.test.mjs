import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

jest.unstable_mockModule("../domain/tenant.mjs", () => ({
  getTenant: jest.fn(),
  upsertTenant: jest.fn(async () => ({})),
}));
jest.unstable_mockModule("../services/blog-credentials.mjs", () => ({
  getBlogCredentials: jest.fn(),
  mergeBlogCredentials: jest.fn(async () => ({})),
}));

const { getTenant, upsertTenant } = await import("../domain/tenant.mjs");
const { getBlogCredentials, mergeBlogCredentials } = await import("../services/blog-credentials.mjs");
const { registerCrosspostSettingsRoutes } = await import("../routes/crosspost-settings.mjs");

const routes = {};
registerCrosspostSettingsRoutes({
  get: (path, fn) => { routes[`GET ${path}`] = fn; },
  put: (path, fn) => { routes[`PUT ${path}`] = fn; },
});

const SUB = "user-1";
const SECRET = "dev-secret-token";

function ctx({ body, authSource = "cognito" } = {}) {
  return {
    event: {
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: { authorizer: { authSource, sub: SUB } },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  getTenant.mockResolvedValue({ platforms: { medium: { publicationId: "pub" } } });
  getBlogCredentials.mockResolvedValue({ dev: SECRET, medium: "m-token" });
});

describe("GET /settings/crosspost", () => {
  test("reports per-platform readiness", async () => {
    const res = await routes["GET /settings/crosspost"](ctx());
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.platforms.dev).toMatchObject({ ready: true, token_configured: true });
    expect(body.platforms.medium).toMatchObject({ ready: true, publication_id: "pub" });
    expect(body.platforms.hashnode).toMatchObject({ ready: false, missing: ["token", "publication_id"] });
  });

  test("never returns a token", async () => {
    const res = await routes["GET /settings/crosspost"](ctx());
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("m-token");
  });

  // Credentials cache per container; after a save the author comes straight
  // back to check, which is exactly when a stale read would say "not set up".
  test("reads credentials past the cache", async () => {
    await routes["GET /settings/crosspost"](ctx());
    expect(getBlogCredentials).toHaveBeenCalledWith(SUB, { forceFetch: true });
  });

  test("reads the tenant row strongly consistent", async () => {
    await routes["GET /settings/crosspost"](ctx());
    expect(getTenant).toHaveBeenCalledWith(SUB, { consistentRead: true });
  });

  test("is dashboard-only", async () => {
    await expect(routes["GET /settings/crosspost"](ctx({ authSource: "apikey" }))).rejects.toThrow(/dashboard sign-in/);
  });
});

describe("PUT /settings/crosspost", () => {
  test("writes tokens to SSM and ids to the tenant row, then reports readiness", async () => {
    const res = await routes["PUT /settings/crosspost"](ctx({
      body: { platforms: { hashnode: { token: "hn", publication_id: "hp" } } },
    }));

    expect(mergeBlogCredentials).toHaveBeenCalledWith(SUB, { hashnode: "hn" });
    expect(upsertTenant).toHaveBeenCalledWith(SUB, { platforms: { hashnode: { publicationId: "hp" } } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty("platforms.hashnode");
  });

  test("a token-only save leaves the tenant row alone", async () => {
    await routes["PUT /settings/crosspost"](ctx({ body: { platforms: { dev: { token: "k" } } } }));
    expect(mergeBlogCredentials).toHaveBeenCalledWith(SUB, { dev: "k" });
    expect(upsertTenant).not.toHaveBeenCalled();
  });

  test("an id-only save leaves the credentials alone", async () => {
    await routes["PUT /settings/crosspost"](ctx({ body: { platforms: { medium: { publication_id: "new" } } } }));
    expect(mergeBlogCredentials).not.toHaveBeenCalled();
    expect(upsertTenant).toHaveBeenCalledWith(SUB, { platforms: { medium: { publicationId: "new" } } });
  });

  test("disconnect clears the token and keeps the publication id", async () => {
    await routes["PUT /settings/crosspost"](ctx({ body: { platforms: { medium: { token: null } } } }));
    expect(mergeBlogCredentials).toHaveBeenCalledWith(SUB, { medium: null });
    expect(upsertTenant).not.toHaveBeenCalled();
  });

  test("never echoes the token it just saved", async () => {
    const res = await routes["PUT /settings/crosspost"](ctx({ body: { platforms: { dev: { token: SECRET } } } }));
    expect(res.body).not.toContain(SECRET);
  });

  // The UI caches the PUT response as the settings state. Reading the save
  // back could land before it's visible and show "Needs publication ID" on a
  // save that succeeded. So the report comes from what was written.
  test("reports on an id save from the written row, not a read-back", async () => {
    getTenant.mockResolvedValue(null); // what a read racing the write would see
    getBlogCredentials.mockResolvedValue({ medium: "m-token" });
    upsertTenant.mockResolvedValueOnce({ platforms: { medium: { publicationId: "pub-new" } } });

    const res = await routes["PUT /settings/crosspost"](ctx({
      body: { platforms: { medium: { publication_id: "pub-new" } } },
    }));

    expect(getTenant).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).platforms.medium).toMatchObject({ ready: true, publication_id: "pub-new", missing: [] });
  });

  test("reports on a token save from the merged blob, not a read-back", async () => {
    getBlogCredentials.mockResolvedValue({}); // stale: no token yet
    mergeBlogCredentials.mockResolvedValueOnce({ medium: "m-token" });

    const res = await routes["PUT /settings/crosspost"](ctx({ body: { platforms: { medium: { token: "m-token" } } } }));

    expect(getBlogCredentials).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).platforms.medium).toMatchObject({ ready: true, token_configured: true });
  });

  // The half this save didn't touch still gets read, and another card may
  // have saved it a moment ago.
  test("reads the untouched half fresh", async () => {
    await routes["PUT /settings/crosspost"](ctx({ body: { platforms: { dev: { token: "k" } } } }));
    expect(getTenant).toHaveBeenCalledWith(SUB, { consistentRead: true });

    jest.clearAllMocks();
    upsertTenant.mockResolvedValueOnce({ platforms: {} });
    await routes["PUT /settings/crosspost"](ctx({ body: { platforms: { medium: { publication_id: "p" } } } }));
    expect(getBlogCredentials).toHaveBeenCalledWith(SUB, { forceFetch: true });
  });

  // A failed SSM write must not leave the ids updated with the token not.
  test("does not touch the tenant row when the credential write fails", async () => {
    mergeBlogCredentials.mockRejectedValueOnce(new Error("KMS AccessDenied"));
    await expect(routes["PUT /settings/crosspost"](ctx({
      body: { platforms: { medium: { token: "m", publication_id: "p" } } },
    }))).rejects.toThrow(/KMS/);
    expect(upsertTenant).not.toHaveBeenCalled();
  });

  // An API key can publish, but must not be able to rewrite the tokens it
  // publishes with.
  test("is dashboard-only, even though cross-posting accepts an API key", async () => {
    await expect(routes["PUT /settings/crosspost"](ctx({
      body: { platforms: { dev: { token: "k" } } }, authSource: "apikey",
    }))).rejects.toThrow(/dashboard sign-in/);
    expect(mergeBlogCredentials).not.toHaveBeenCalled();
  });
});
