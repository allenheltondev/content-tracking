import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

jest.unstable_mockModule("../domain/tenant.mjs", () => ({ getTenant: jest.fn() }));
jest.unstable_mockModule("../domain/content.mjs", () => ({
  listContentByTenant: jest.fn(async () => ({ items: [] })),
  listPublishVariants: jest.fn(async () => []),
  putPublishVariant: jest.fn(async () => ({})),
  setPlatformLink: jest.fn(async () => {}),
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
const { listPublishVariants, putPublishVariant, setPlatformLink } = await import("../domain/content.mjs");
const { getBlogCredentials } = await import("../services/blog-credentials.mjs");
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

describe("crosspostContent bookkeeping", () => {
  let publish;

  beforeEach(() => {
    jest.clearAllMocks();
    getTenant.mockResolvedValue({ canonicalBaseUrl: "https://example.com" });
    listPublishVariants.mockResolvedValue([]);
    publish = jest.fn(async () => ({ id: 42, url: "https://dev.to/me/hi" }));
    getAdapter.mockReturnValue({ publish });
  });

  // The credentials cache is per Lambda container. Reading through it, a token
  // saved on the settings page a moment ago can still read as missing here, so
  // the first cross-post after setting up would fail with "not configured".
  test("reads credentials past the cache", async () => {
    await crosspostContent({ tenantId: "T1", content: CONTENT, platforms: ["dev"] });
    expect(getBlogCredentials).toHaveBeenCalledWith("T1", { forceFetch: true });
  });

  // links.<platform> is what cross-link rewriting reads when another post that
  // links here is cross-posted. Before this, nothing live wrote it.
  test("records the platform link alongside the publish variant", async () => {
    await crosspostContent({ tenantId: "T1", content: CONTENT, platforms: ["dev"] });

    expect(putPublishVariant).toHaveBeenCalledWith("T1", "C1", "dev", expect.objectContaining({ url: "https://dev.to/me/hi" }));
    expect(setPlatformLink).toHaveBeenCalledWith("T1", "C1", "dev", "https://dev.to/me/hi");
  });

  // The post is already live when the link write runs. Reporting that as a
  // failure would invite a retry, and the retry would post a second copy.
  test("a failed link write does not turn a live post into a failure", async () => {
    setPlatformLink.mockRejectedValueOnce(new Error("throttled"));

    const results = await crosspostContent({ tenantId: "T1", content: CONTENT, platforms: ["dev"] });

    expect(results).toEqual([{ platform: "dev", status: "succeeded", url: "https://dev.to/me/hi" }]);
  });

  test("a platform already posted (by hand or by us) is skipped and not re-linked", async () => {
    listPublishVariants.mockResolvedValue([{ platform: "dev", url: "https://dev.to/me/by-hand" }]);

    const results = await crosspostContent({ tenantId: "T1", content: CONTENT, platforms: ["dev"] });

    expect(publish).not.toHaveBeenCalled();
    expect(setPlatformLink).not.toHaveBeenCalled();
    expect(results).toEqual([{ platform: "dev", status: "skipped", url: "https://dev.to/me/by-hand" }]);
  });
});
