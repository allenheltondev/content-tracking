import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

jest.unstable_mockModule("../domain/tenant.mjs", () => ({ getTenant: jest.fn() }));

const { getTenant } = await import("../domain/tenant.mjs");
const { isRelativeCanonical, absolutizeCanonical, canonicalBaseFor } = await import(
  "../services/canonical-url.mjs"
);

describe("services/canonical-url", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("isRelativeCanonical", () => {
    test("a single leading slash is a path on this site", () => {
      expect(isRelativeCanonical("/blog/my-post/")).toBe(true);
    });

    test("absolute and protocol-relative URLs are not", () => {
      expect(isRelativeCanonical("https://example.com/blog/")).toBe(false);
      // "//evil.com" leaves the site, so it is not a path on it.
      expect(isRelativeCanonical("//evil.com/blog/")).toBe(false);
      expect(isRelativeCanonical(undefined)).toBe(false);
    });
  });

  describe("absolutizeCanonical", () => {
    test("joins a path with the base, tolerating a trailing slash on the base", () => {
      expect(absolutizeCanonical("/blog/x/", "https://example.com")).toBe("https://example.com/blog/x/");
      expect(absolutizeCanonical("/blog/x/", "https://example.com/")).toBe("https://example.com/blog/x/");
    });

    test("passes an absolute canonical through untouched", () => {
      expect(absolutizeCanonical("https://elsewhere.dev/p/", "https://example.com")).toBe("https://elsewhere.dev/p/");
    });

    test("returns null rather than a bare path when no base is configured", () => {
      // A path handed out as a URL would resolve against whatever origin the
      // reader happens to be on.
      expect(absolutizeCanonical("/blog/x/", null)).toBeNull();
      expect(absolutizeCanonical(null, "https://example.com")).toBeNull();
    });
  });

  describe("canonicalBaseFor", () => {
    test("skips the tenant read when nothing stores a path", async () => {
      const base = await canonicalBaseFor("T1", [
        { canonicalUrl: "https://example.com/a/" },
        { canonicalUrl: null },
      ]);
      expect(base).toBeNull();
      expect(getTenant).not.toHaveBeenCalled();
    });

    test("reads the tenant's base when a row stores a path", async () => {
      getTenant.mockResolvedValue({ canonicalBaseUrl: "https://example.com" });
      expect(await canonicalBaseFor("T1", { canonicalUrl: "/blog/x/" })).toBe("https://example.com");
      expect(getTenant).toHaveBeenCalledWith("T1");
    });

    test("a failed tenant read degrades to no base rather than failing the request", async () => {
      getTenant.mockRejectedValue(new Error("throttled"));
      expect(await canonicalBaseFor("T1", { canonicalUrl: "/blog/x/" })).toBeNull();
    });
  });
});
