import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

// Mock every collaborator so the PUT route's slug-change teardown logic is
// exercised in isolation.
jest.unstable_mockModule("../domain/profile.mjs", () => ({
  getProfileSettings: jest.fn(),
  saveProfileSettings: jest.fn(),
  clearPublicMediaKitPublished: jest.fn(),
}));
jest.unstable_mockModule("../services/profile-assets.mjs", () => ({
  presignProfileImageUpload: jest.fn(),
  signProfileAssetUrl: jest.fn(() => ({ url: "https://cdn/x", expiresAt: "x" })),
}));
jest.unstable_mockModule("../services/public-media-kit-store.mjs", () => ({
  publicMediaKitUrl: jest.fn((slug) => `https://kit.example.com/${slug}`),
  unpublishMediaKit: jest.fn(),
  removePublicMediaKitSeoFiles: jest.fn(),
}));
jest.unstable_mockModule("../services/ga-secrets.mjs", () => ({
  readGa4ServiceAccount: jest.fn(async () => null),
  readCruxApiKey: jest.fn(async () => null),
  writeGa4ServiceAccount: jest.fn(),
  writeCruxApiKey: jest.fn(),
}));

const {
  getProfileSettings,
  saveProfileSettings,
  clearPublicMediaKitPublished,
} = await import("../domain/profile.mjs");
const { unpublishMediaKit, removePublicMediaKitSeoFiles } = await import(
  "../services/public-media-kit-store.mjs"
);
const { registerProfileRoutes } = await import("../routes/profile.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    get: (path, handler) => { routes[`GET ${path}`] = handler; },
    put: (path, handler) => { routes[`PUT ${path}`] = handler; },
    post: (path, handler) => { routes[`POST ${path}`] = handler; },
  };
  registerProfileRoutes(app);
  return routes;
}

const put = buildRouteTable()["PUT /profile"];

function event(body) {
  return { event: { body: JSON.stringify(body) } };
}

describe("PUT /profile public_slug teardown", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    saveProfileSettings.mockResolvedValue({});
    clearPublicMediaKitPublished.mockResolvedValue({});
    unpublishMediaKit.mockResolvedValue(undefined);
    removePublicMediaKitSeoFiles.mockResolvedValue(undefined);
  });

  test("retires the old published page when the slug changes", async () => {
    // First read (prior state): published under "old". Second read powers the
    // response view after the write.
    getProfileSettings
      .mockResolvedValueOnce({ publicSlug: "old", publicMediaKitPublishedAt: "2026-05-31T00:00:00.000Z" })
      .mockResolvedValueOnce({ publicSlug: "new" });

    await put(event({ public_slug: "new" }));

    expect(saveProfileSettings).toHaveBeenCalledWith(expect.objectContaining({ publicSlug: "new" }));
    // Old page + SEO files torn down and the published flag cleared.
    expect(unpublishMediaKit).toHaveBeenCalledWith({ slug: "old" });
    expect(removePublicMediaKitSeoFiles).toHaveBeenCalledTimes(1);
    expect(clearPublicMediaKitPublished).toHaveBeenCalledTimes(1);
  });

  test("retires the old page when the slug is cleared to null", async () => {
    getProfileSettings
      .mockResolvedValueOnce({ publicSlug: "old", publicMediaKitPublishedAt: "2026-05-31T00:00:00.000Z" })
      .mockResolvedValueOnce({});

    await put(event({ public_slug: null }));

    expect(unpublishMediaKit).toHaveBeenCalledWith({ slug: "old" });
    expect(clearPublicMediaKitPublished).toHaveBeenCalledTimes(1);
  });

  test("does nothing extra when the slug is unchanged", async () => {
    getProfileSettings
      .mockResolvedValueOnce({ publicSlug: "same", publicMediaKitPublishedAt: "2026-05-31T00:00:00.000Z" })
      .mockResolvedValueOnce({ publicSlug: "same", publicMediaKitPublishedAt: "2026-05-31T00:00:00.000Z" });

    await put(event({ public_slug: "same", tagline: "hi" }));

    expect(unpublishMediaKit).not.toHaveBeenCalled();
    expect(clearPublicMediaKitPublished).not.toHaveBeenCalled();
  });

  test("does not tear down when the slug changes but nothing was published", async () => {
    getProfileSettings
      .mockResolvedValueOnce({ publicSlug: "old" }) // never published
      .mockResolvedValueOnce({ publicSlug: "new" });

    await put(event({ public_slug: "new" }));

    expect(unpublishMediaKit).not.toHaveBeenCalled();
    expect(clearPublicMediaKitPublished).not.toHaveBeenCalled();
  });

  test("leaves the published page alone when public_slug is absent from the body", async () => {
    getProfileSettings
      .mockResolvedValueOnce({ publicSlug: "old", publicMediaKitPublishedAt: "2026-05-31T00:00:00.000Z" })
      .mockResolvedValueOnce({ publicSlug: "old", publicMediaKitPublishedAt: "2026-05-31T00:00:00.000Z" });

    await put(event({ tagline: "just editing the tagline" }));

    expect(unpublishMediaKit).not.toHaveBeenCalled();
    expect(clearPublicMediaKitPublished).not.toHaveBeenCalled();
  });
});
