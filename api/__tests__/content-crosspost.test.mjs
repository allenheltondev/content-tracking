import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

jest.unstable_mockModule("../domain/tenant.mjs", () => ({ getTenant: jest.fn() }));
jest.unstable_mockModule("../domain/content.mjs", () => ({
  listContentByTenant: jest.fn(async () => ({ items: [] })),
  listPublishVariants: jest.fn(async () => []),
  putPublishVariant: jest.fn(async () => ({})),
}));
jest.unstable_mockModule("../services/blog-credentials.mjs", () => ({
  getBlogCredentials: jest.fn(async () => ({ devto: "key" })),
}));
jest.unstable_mockModule("../services/parse-blog.mjs", () => ({
  transformBlogForPlatform: jest.fn(({ blog }) => ({ body: blog.contentMarkdown, tags: [] })),
}));
jest.unstable_mockModule("../services/blog-platforms/index.mjs", () => ({
  getAdapter: jest.fn(),
}));

const { getTenant } = await import("../domain/tenant.mjs");
const { getAdapter } = await import("../services/blog-platforms/index.mjs");
const { crosspostContent } = await import("../services/content-crosspost.mjs");

const CONTENT = { contentId: "C1", title: "Hi", contentMarkdown: "# body", canonicalUrl: "/blog/hi/" };

describe("crosspostContent canonical handling", () => {
  let publish;

  beforeEach(() => {
    jest.clearAllMocks();
    publish = jest.fn(async () => ({ url: "https://dev.to/p/hi" }));
    getAdapter.mockReturnValue({ publish });
  });

  // dev.to's canonical_url, Medium's canonicalUrl and Hashnode's
  // originalArticleURL are copied straight off the row, so a stored path has to
  // become a real URL before it leaves the building.
  test("hands the platform an absolute URL built from the tenant's base", async () => {
    getTenant.mockResolvedValue({ canonicalBaseUrl: "https://example.com" });

    await crosspostContent({ tenantId: "T1", content: CONTENT, platforms: ["devto"] });

    expect(publish.mock.calls[0][0].blog.canonicalUrl).toBe("https://example.com/blog/hi/");
  });

  test("sends no canonical at all when the base URL isn't configured", async () => {
    getTenant.mockResolvedValue(null);

    await crosspostContent({ tenantId: "T1", content: CONTENT, platforms: ["devto"] });

    // Better for the platform to have none than to record a path against its
    // own domain.
    expect(publish.mock.calls[0][0].blog.canonicalUrl).toBeUndefined();
  });

  test("leaves an absolute canonical exactly as stored", async () => {
    getTenant.mockResolvedValue({ canonicalBaseUrl: "https://example.com" });

    await crosspostContent({
      tenantId: "T1",
      content: { ...CONTENT, canonicalUrl: "https://elsewhere.dev/p/" },
      platforms: ["devto"],
    });

    expect(publish.mock.calls[0][0].blog.canonicalUrl).toBe("https://elsewhere.dev/p/");
  });
});
