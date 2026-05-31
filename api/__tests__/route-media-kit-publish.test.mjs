import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

jest.unstable_mockModule("../domain/profile.mjs", () => ({
  getProfileSettings: jest.fn(),
  markPublicMediaKitPublished: jest.fn(),
  clearPublicMediaKitPublished: jest.fn(),
}));
jest.unstable_mockModule("../domain/media-kit.mjs", () => ({
  buildMediaKitSnapshot: jest.fn(),
  toPublicTeaser: jest.fn((snap, opts) => ({ ...snap, teaser: true, ...opts })),
}));
jest.unstable_mockModule("../services/media-kit-renderer.mjs", () => ({
  renderMediaKitHtml: jest.fn(),
}));
jest.unstable_mockModule("../services/public-media-kit-store.mjs", () => ({
  publishMediaKitHtml: jest.fn(),
  unpublishMediaKit: jest.fn(),
  copyProfileAssetToPublic: jest.fn(),
  publicMediaKitUrl: jest.fn((slug) => `https://kit.example.com/${slug}`),
  writePublicMediaKitSeoFiles: jest.fn(),
  removePublicMediaKitSeoFiles: jest.fn(),
}));

const {
  getProfileSettings,
  markPublicMediaKitPublished,
  clearPublicMediaKitPublished,
} = await import("../domain/profile.mjs");
const { buildMediaKitSnapshot, toPublicTeaser } = await import("../domain/media-kit.mjs");
const { renderMediaKitHtml } = await import("../services/media-kit-renderer.mjs");
const {
  publishMediaKitHtml,
  unpublishMediaKit,
  copyProfileAssetToPublic,
  writePublicMediaKitSeoFiles,
  removePublicMediaKitSeoFiles,
} = await import("../services/public-media-kit-store.mjs");
const { registerMediaKitPublishRoutes } = await import("../routes/media-kit-publish.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    post: (path, handler) => { routes[`POST ${path}`] = handler; },
    get: (path, handler) => { routes[`GET ${path}`] = handler; },
    delete: (path, handler) => { routes[`DELETE ${path}`] = handler; },
  };
  registerMediaKitPublishRoutes(app);
  return routes;
}

const routes = buildRouteTable();
const post = routes["POST /media-kit/publish"];
const del = routes["DELETE /media-kit/publish"];
const get = routes["GET /media-kit/publish"];

const SNAPSHOT = {
  report: { id: null, generatedAt: "2026-05-31T00:00:00.000Z", kind: "media-kit" },
  identity: { displayName: "Allen" },
  rateCard: [{ deliverable: "Post", price: 2500 }],
  stats: {},
};

describe("routes/media-kit-publish", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The route .catch()es these best-effort SEO writes, so they must always
    // return a promise. Tests override when asserting specifics.
    writePublicMediaKitSeoFiles.mockResolvedValue(undefined);
    removePublicMediaKitSeoFiles.mockResolvedValue(undefined);
  });

  test("registers POST, GET, DELETE", () => {
    expect(typeof post).toBe("function");
    expect(typeof get).toBe("function");
    expect(typeof del).toBe("function");
  });

  describe("POST /media-kit/publish", () => {
    test("400 when no public_slug is set", async () => {
      getProfileSettings.mockResolvedValue({});
      await expect(post({})).rejects.toThrow(/public_slug/);
      expect(buildMediaKitSnapshot).not.toHaveBeenCalled();
    });

    test("copies assets, renders indexable teaser, publishes, stamps profile", async () => {
      getProfileSettings.mockResolvedValue({
        publicSlug: "allen",
        avatarKey: "profile/avatar-01HZX7M6Z5GQK6T7Q8N9R0P1V2.png",
        logoKey: "profile/logo-01HZX7M6Z5GQK6T7Q8N9R0P1V3.png",
      });
      buildMediaKitSnapshot.mockResolvedValue(SNAPSHOT);
      copyProfileAssetToPublic
        .mockResolvedValueOnce("https://kit.example.com/allen/avatar")
        .mockResolvedValueOnce("https://kit.example.com/allen/logo");
      renderMediaKitHtml.mockReturnValue("<html>teaser</html>");
      publishMediaKitHtml.mockResolvedValue("https://kit.example.com/allen");
      writePublicMediaKitSeoFiles.mockResolvedValue(undefined);
      markPublicMediaKitPublished.mockResolvedValue({});

      const res = await post({});

      // Teaser built with the public image URLs from the copy step.
      expect(toPublicTeaser).toHaveBeenCalledWith(SNAPSHOT, {
        avatarUrl: "https://kit.example.com/allen/avatar",
        logoUrl: "https://kit.example.com/allen/logo",
      });
      // Rendered with indexable: true and the canonical pageUrl (drives the
      // SEO head's canonical/OG/JSON-LD url fields).
      expect(renderMediaKitHtml).toHaveBeenCalledWith(
        expect.objectContaining({ teaser: true }),
        { indexable: true, pageUrl: "https://kit.example.com/allen" },
      );
      expect(publishMediaKitHtml).toHaveBeenCalledWith({ slug: "allen", html: "<html>teaser</html>" });
      // robots.txt + sitemap.xml written for crawlers.
      expect(writePublicMediaKitSeoFiles).toHaveBeenCalledWith(
        expect.objectContaining({ slug: "allen" }),
      );
      expect(markPublicMediaKitPublished).toHaveBeenCalledTimes(1);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ slug: "allen", url: "https://kit.example.com/allen", published: true });
      expect(typeof body.published_at).toBe("string");
    });

    test("a failed asset copy degrades to a null image url, still publishes", async () => {
      getProfileSettings.mockResolvedValue({
        publicSlug: "allen",
        avatarKey: "profile/avatar-01HZX7M6Z5GQK6T7Q8N9R0P1V2.png",
      });
      buildMediaKitSnapshot.mockResolvedValue(SNAPSHOT);
      copyProfileAssetToPublic.mockRejectedValue(new Error("s3 down"));
      renderMediaKitHtml.mockReturnValue("<html></html>");
      publishMediaKitHtml.mockResolvedValue("https://kit.example.com/allen");
      markPublicMediaKitPublished.mockResolvedValue({});

      const res = await post({});

      expect(toPublicTeaser).toHaveBeenCalledWith(SNAPSHOT, { avatarUrl: null, logoUrl: null });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("DELETE /media-kit/publish", () => {
    test("unpublishes the page and clears the timestamp", async () => {
      getProfileSettings.mockResolvedValue({ publicSlug: "allen" });
      const res = await del({});
      expect(unpublishMediaKit).toHaveBeenCalledWith({ slug: "allen" });
      expect(removePublicMediaKitSeoFiles).toHaveBeenCalledTimes(1);
      expect(clearPublicMediaKitPublished).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(204);
    });

    test("is a no-op success when no slug is set", async () => {
      getProfileSettings.mockResolvedValue({});
      const res = await del({});
      expect(unpublishMediaKit).not.toHaveBeenCalled();
      expect(clearPublicMediaKitPublished).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(204);
    });
  });

  describe("GET /media-kit/publish", () => {
    test("reports published state and url", async () => {
      getProfileSettings.mockResolvedValue({
        publicSlug: "allen",
        publicMediaKitPublishedAt: "2026-05-31T00:00:00.000Z",
      });
      const res = await get({});
      expect(JSON.parse(res.body)).toEqual({
        slug: "allen",
        published: true,
        url: "https://kit.example.com/allen",
        published_at: "2026-05-31T00:00:00.000Z",
      });
    });

    test("url is null when a slug exists but isn't published", async () => {
      getProfileSettings.mockResolvedValue({ publicSlug: "allen" });
      const res = await get({});
      expect(JSON.parse(res.body)).toEqual({
        slug: "allen",
        published: false,
        url: null,
        published_at: null,
      });
    });
  });
});
