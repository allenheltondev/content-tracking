const {
  validateFeedCreate,
  validateFeedUpdate,
  validateIdeasRequest,
  validateRadarPrefs,
  formatFeedSource,
  formatFeedItem,
  formatFeedResult,
  formatContentIdeas,
  formatRadarPrefs,
  IDEAS_ITEM_MAX,
} = await import("../validation/feed.mjs");

describe("validation/feed validateFeedCreate", () => {
  test("accepts a public feed URL and optional title", () => {
    expect(validateFeedCreate({ url: "https://a.com/feed.xml", title: "  A  " }))
      .toEqual({ url: "https://a.com/feed.xml", title: "A" });
    expect(validateFeedCreate({ url: "https://a.com/feed.xml" })).toEqual({ url: "https://a.com/feed.xml" });
  });

  test("rejects a missing / non-string / empty url", () => {
    expect(() => validateFeedCreate({})).toThrow(/url must be/);
    expect(() => validateFeedCreate({ url: "" })).toThrow(/url must be/);
    expect(() => validateFeedCreate({ url: 5 })).toThrow(/url must be/);
  });

  test("rejects non-public / SSRF-y URLs", () => {
    expect(() => validateFeedCreate({ url: "http://localhost/feed" })).toThrow(/public http/);
    expect(() => validateFeedCreate({ url: "http://169.254.169.254/" })).toThrow(/public http/);
    expect(() => validateFeedCreate({ url: "ftp://a.com/feed" })).toThrow(/public http/);
    expect(() => validateFeedCreate({ url: "not a url" })).toThrow(/public http/);
  });

  test("rejects an over-long title", () => {
    expect(() => validateFeedCreate({ url: "https://a.com/feed", title: "x".repeat(201) })).toThrow(/at most 200/);
  });

  test("rejects a non-object body", () => {
    expect(() => validateFeedCreate(null)).toThrow(/JSON object/);
    expect(() => validateFeedCreate([])).toThrow(/JSON object/);
  });
});

describe("validation/feed validateFeedUpdate", () => {
  test("accepts title rename, title clear, and mute toggle", () => {
    expect(validateFeedUpdate({ title: "New" })).toEqual({ title: "New" });
    expect(validateFeedUpdate({ title: null })).toEqual({ title: null });
    expect(validateFeedUpdate({ muted: true })).toEqual({ muted: true });
    expect(validateFeedUpdate({ title: "N", muted: false })).toEqual({ title: "N", muted: false });
  });

  test("requires at least one field", () => {
    expect(() => validateFeedUpdate({})).toThrow(/at least one/);
  });

  test("rejects a non-boolean muted", () => {
    expect(() => validateFeedUpdate({ muted: "yes" })).toThrow(/muted must be a boolean/);
  });
});

describe("validation/feed validateIdeasRequest", () => {
  test("accepts an empty body (all optional)", () => {
    expect(validateIdeasRequest({})).toEqual({});
    expect(validateIdeasRequest(undefined)).toEqual({});
  });

  test("accepts platform, guidance, feed_ids, and limit", () => {
    const out = validateIdeasRequest({
      platform: "blog",
      guidance: "  more contrarian  ",
      feed_ids: ["F1", "F2"],
      limit: 10,
    });
    expect(out).toEqual({ platform: "blog", guidance: "more contrarian", feedIds: ["F1", "F2"], limit: 10 });
  });

  test("rejects an unknown platform", () => {
    expect(() => validateIdeasRequest({ platform: "myspace" })).toThrow(/platform must be/);
  });

  test("rejects a bad feed_ids array", () => {
    expect(() => validateIdeasRequest({ feed_ids: "F1" })).toThrow(/feed_ids/);
    expect(() => validateIdeasRequest({ feed_ids: [1, 2] })).toThrow(/feed_ids/);
  });

  test("rejects an out-of-range limit", () => {
    expect(() => validateIdeasRequest({ limit: 0 })).toThrow(/limit must be/);
    expect(() => validateIdeasRequest({ limit: IDEAS_ITEM_MAX + 1 })).toThrow(/limit must be/);
    expect(() => validateIdeasRequest({ limit: 1.5 })).toThrow(/limit must be/);
  });

  test("rejects an over-long guidance", () => {
    expect(() => validateIdeasRequest({ guidance: "x".repeat(1001) })).toThrow(/at most 1000/);
  });
});

describe("validation/feed validateRadarPrefs", () => {
  test("normalizes topic lists: trims, dedupes case-insensitively, drops empties", () => {
    const out = validateRadarPrefs({ interests: ["  Serverless ", "serverless", "", "Events"] });
    expect(out.interests).toEqual(["Serverless", "Events"]);
  });

  test("accepts all fields", () => {
    const out = validateRadarPrefs({
      interests: ["a"],
      avoid: ["b"],
      default_platform: "blog",
      default_guidance: "  contrarian  ",
      audience: "  devs  ",
    });
    expect(out).toEqual({
      interests: ["a"],
      avoid: ["b"],
      defaultPlatform: "blog",
      defaultGuidance: "contrarian",
      audience: "devs",
    });
  });

  test("clears scalars with null / empty string", () => {
    expect(validateRadarPrefs({ default_platform: null, default_guidance: "", audience: null }))
      .toEqual({ defaultPlatform: null, defaultGuidance: null, audience: null });
  });

  test("clears topic lists with an empty array", () => {
    expect(validateRadarPrefs({ interests: [], avoid: [] })).toEqual({ interests: [], avoid: [] });
  });

  test("rejects an unknown default_platform", () => {
    expect(() => validateRadarPrefs({ default_platform: "myspace" })).toThrow(/default_platform/);
  });

  test("rejects a non-string topic and over-long entries", () => {
    expect(() => validateRadarPrefs({ interests: [5] })).toThrow(/array of strings/);
    expect(() => validateRadarPrefs({ interests: ["x".repeat(121)] })).toThrow(/at most 120/);
  });

  test("rejects too many topics", () => {
    const many = Array.from({ length: 31 }, (_, i) => `t${i}`);
    expect(() => validateRadarPrefs({ interests: many })).toThrow(/at most 30/);
  });

  test("requires at least one field", () => {
    expect(() => validateRadarPrefs({})).toThrow(/at least one/);
  });

  test("formatRadarPrefs defaults to empty lists / nulls", () => {
    expect(formatRadarPrefs(null)).toEqual({
      interests: [], avoid: [], default_platform: null, default_guidance: null, audience: null, updated_at: null,
    });
    expect(formatRadarPrefs({ interests: ["a"], defaultPlatform: "x", updatedAt: "t" })).toEqual({
      interests: ["a"], avoid: [], default_platform: "x", default_guidance: null, audience: null, updated_at: "t",
    });
  });
});

describe("validation/feed formatters", () => {
  test("formatFeedSource surfaces health fields", () => {
    const out = formatFeedSource({
      feedId: "F1",
      url: "https://a.com/feed",
      title: "A",
      muted: true,
      lastFetchedAt: "2026-07-13T00:00:00.000Z",
      lastStatus: "error",
      lastError: "boom",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    expect(out).toEqual({
      feed_id: "F1",
      url: "https://a.com/feed",
      title: "A",
      muted: true,
      last_fetched_at: "2026-07-13T00:00:00.000Z",
      last_status: "error",
      last_item_count: null,
      last_error: "boom",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-02T00:00:00.000Z",
    });
  });

  test("formatFeedItem maps camelCase to snake_case", () => {
    expect(formatFeedItem({
      title: "T", link: "L", summary: "S", author: "A",
      publishedAt: "2026-07-13T00:00:00.000Z", feedId: "F1", feedTitle: "Feed", sourceUrl: "U",
    })).toEqual({
      title: "T", link: "L", summary: "S", author: "A",
      published_at: "2026-07-13T00:00:00.000Z", feed_id: "F1", feed_title: "Feed", source_url: "U",
    });
  });

  test("formatFeedResult reports per-source outcome", () => {
    expect(formatFeedResult({ feedId: "F1", url: "u", ok: false, itemCount: 0, error: "bad" }))
      .toEqual({ feed_id: "F1", url: "u", ok: false, item_count: 0, feed_title: null, error: "bad" });
  });

  test("formatContentIdeas normalizes themes and angles", () => {
    const out = formatContentIdeas({
      summary: "hot topics",
      themes: [{ theme: "AI agents", momentum: "surging", why_it_fits: "your lane" }],
      angles: [{
        title: "Why agents fail",
        angle: "the take",
        format: "blog",
        rationale: "timely",
        on_voice_note: "be blunt",
        sources: [1, 3],
      }],
    });
    expect(out.summary).toBe("hot topics");
    expect(out.themes[0]).toEqual({ theme: "AI agents", momentum: "surging", why_it_fits: "your lane" });
    expect(out.angles[0].title).toBe("Why agents fail");
    expect(out.angles[0].sources).toEqual([1, 3]);
  });

  test("formatContentIdeas tolerates missing arrays", () => {
    expect(formatContentIdeas({ summary: null })).toEqual({ summary: null, themes: [], angles: [] });
  });
});
