import {
  derivePlatform,
  formatContentPost,
  validateAnalyticsUpdate,
  validateContentPostCreate,
} from "../validation/content-post.mjs";

describe("validation/content-post", () => {
  describe("derivePlatform", () => {
    test.each([
      ["https://medium.com/@allen/my-post-abc123", "medium"],
      ["https://allen.medium.com/my-post-abc123", "medium"],
      ["https://www.medium.com/p/abc123", "medium"],
      ["https://dev.to/allenheltondev/my-post-1abc", "devto"],
      ["https://x.com/foo/status/123", null],
      ["not a url", null],
    ])("%s -> %s", (url, expected) => {
      expect(derivePlatform(url)).toBe(expected);
    });
  });

  describe("validateContentPostCreate", () => {
    test("infers platform from url", () => {
      const out = validateContentPostCreate({ url: "https://medium.com/@allen/foo-abc" });
      expect(out).toEqual({ url: "https://medium.com/@allen/foo-abc", platform: "medium" });
    });

    test("accepts explicit platform and notes", () => {
      const out = validateContentPostCreate({
        url: "https://medium.com/@allen/foo-abc",
        platform: "medium",
        notes: "cross-post",
      });
      expect(out.platform).toBe("medium");
      expect(out.notes).toBe("cross-post");
    });

    test("rejects non-http url", () => {
      expect(() => validateContentPostCreate({ url: "ftp://medium.com" })).toThrow(/http or https/);
    });

    test("rejects unknown platform", () => {
      expect(() =>
        validateContentPostCreate({ url: "https://medium.com/x", platform: "substack" }),
      ).toThrow(/platform must be one of/);
    });

    test("rejects url with no inferable platform", () => {
      expect(() => validateContentPostCreate({ url: "https://example.com/x" })).toThrow(
        /could not infer platform/,
      );
    });
  });

  describe("validateAnalyticsUpdate", () => {
    test("accepts numeric metrics and optional capturedAt", () => {
      const out = validateAnalyticsUpdate({
        metrics: { views: 1200, claps: 80, comments: 4 },
        capturedAt: "2026-05-27T10:00:00.000Z",
      });
      expect(out.metrics).toEqual({ views: 1200, claps: 80, comments: 4 });
      expect(out.capturedAt).toBe("2026-05-27T10:00:00.000Z");
    });

    test("rejects empty metrics", () => {
      expect(() => validateAnalyticsUpdate({ metrics: {} })).toThrow(/at least one metric/);
    });

    test("rejects negative or non-numeric values", () => {
      expect(() => validateAnalyticsUpdate({ metrics: { views: -1 } })).toThrow(/non-negative/);
      expect(() => validateAnalyticsUpdate({ metrics: { views: "10" } })).toThrow(/non-negative/);
    });

    test("rejects bad capturedAt", () => {
      expect(() =>
        validateAnalyticsUpdate({ metrics: { views: 1 }, capturedAt: "nope" }),
      ).toThrow(/ISO date-time/);
    });
  });

  describe("formatContentPost", () => {
    test("maps internal row to API shape with nulls for absent fields", () => {
      const out = formatContentPost({
        campaignId: "C1",
        postId: "P1",
        platform: "medium",
        url: "https://medium.com/@allen/foo-abc",
        createdAt: "2026-05-27T00:00:00.000Z",
      });
      expect(out).toEqual({
        campaign_id: "C1",
        post_id: "P1",
        platform: "medium",
        url: "https://medium.com/@allen/foo-abc",
        notes: null,
        analytics: null,
        last_fetched: null,
        captured_at: null,
        created_at: "2026-05-27T00:00:00.000Z",
        updated_at: null,
      });
    });
  });
});
