import {
  derivePlatform,
  formatSocialPost,
  validateAnalyticsUpdate,
  validateSocialPostCreate,
} from "../validation/social-post.mjs";

describe("validation/social-post", () => {
  describe("derivePlatform", () => {
    test.each([
      ["https://x.com/foo/status/123", "twitter"],
      ["https://twitter.com/foo/status/123", "twitter"],
      ["https://www.linkedin.com/feed/update/urn:li:activity:123/", "linkedin"],
      ["https://www.instagram.com/p/abc/", "instagram"],
      ["https://bsky.app/profile/alice.bsky.social/post/3kj2lxyz7s2k", "bluesky"],
      ["https://example.com/foo", null],
      ["not a url", null],
    ])("%s -> %s", (url, expected) => {
      expect(derivePlatform(url)).toBe(expected);
    });
  });

  describe("validateSocialPostCreate", () => {
    test("infers platform from url", () => {
      const out = validateSocialPostCreate({ url: "https://x.com/a/status/1" });
      expect(out).toEqual({ url: "https://x.com/a/status/1", platform: "twitter" });
    });

    test("accepts explicit platform and notes", () => {
      const out = validateSocialPostCreate({
        url: "https://x.com/a/status/1",
        platform: "twitter",
        notes: "hero post",
      });
      expect(out.platform).toBe("twitter");
      expect(out.notes).toBe("hero post");
    });

    test("rejects non-http url", () => {
      expect(() => validateSocialPostCreate({ url: "ftp://x.com" })).toThrow(/http or https/);
    });

    test("rejects unknown platform", () => {
      expect(() =>
        validateSocialPostCreate({ url: "https://x.com/a/status/1", platform: "tiktok" }),
      ).toThrow(/platform must be one of/);
    });

    test("rejects url with no inferable platform", () => {
      expect(() => validateSocialPostCreate({ url: "https://example.com/x" })).toThrow(
        /could not infer platform/,
      );
    });
  });

  describe("validateAnalyticsUpdate", () => {
    test("accepts numeric metrics and optional capturedAt", () => {
      const out = validateAnalyticsUpdate({
        metrics: { likes: 10, reposts: 2 },
        capturedAt: "2026-05-27T10:00:00.000Z",
      });
      expect(out.metrics).toEqual({ likes: 10, reposts: 2 });
      expect(out.capturedAt).toBe("2026-05-27T10:00:00.000Z");
    });

    test("rejects empty metrics", () => {
      expect(() => validateAnalyticsUpdate({ metrics: {} })).toThrow(/at least one metric/);
    });

    test("rejects negative or non-numeric values", () => {
      expect(() => validateAnalyticsUpdate({ metrics: { likes: -1 } })).toThrow(/non-negative/);
      expect(() => validateAnalyticsUpdate({ metrics: { likes: "10" } })).toThrow(/non-negative/);
    });

    test("rejects bad capturedAt", () => {
      expect(() =>
        validateAnalyticsUpdate({ metrics: { likes: 1 }, capturedAt: "nope" }),
      ).toThrow(/ISO date-time/);
    });
  });

  describe("formatSocialPost", () => {
    test("maps internal row to API shape with nulls for absent fields", () => {
      const out = formatSocialPost({
        campaignId: "C1",
        postId: "P1",
        platform: "twitter",
        url: "https://x.com/a/status/1",
        createdAt: "2026-05-27T00:00:00.000Z",
      });
      expect(out).toEqual({
        campaign_id: "C1",
        post_id: "P1",
        platform: "twitter",
        url: "https://x.com/a/status/1",
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
