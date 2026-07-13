import {
  validateComposeRequest,
  validateSampleCreate,
  validatePlatform,
  formatVoiceDraft,
  formatVoiceSample,
  formatVoiceProfile,
  formatVoiceReflection,
} from "../validation/voice.mjs";

describe("validation/voice", () => {
  describe("validateComposeRequest", () => {
    test("accepts a social request", () => {
      expect(validateComposeRequest({ topic: "ship it", platform: "x", format: "social", guidance: "be punchy" }))
        .toEqual({ topic: "ship it", platform: "x", format: "social", guidance: "be punchy" });
    });

    test("requires a non-empty topic and a known platform", () => {
      expect(() => validateComposeRequest({ topic: "  ", platform: "x", format: "social" })).toThrow(/topic/);
      expect(() => validateComposeRequest({ topic: "t", platform: "myspace", format: "social" })).toThrow(/platform/);
    });

    test("pins platform=blog to format=blog", () => {
      expect(() => validateComposeRequest({ topic: "t", platform: "blog", format: "social" }))
        .toThrow(/requires format "blog"/);
      expect(validateComposeRequest({ topic: "t", platform: "blog", format: "blog" }).format).toBe("blog");
    });

    test("allows long-form on a social platform (linkedin article)", () => {
      expect(validateComposeRequest({ topic: "t", platform: "linkedin", format: "blog" }).format).toBe("blog");
    });
  });

  describe("validateSampleCreate", () => {
    test("defaults source to manual and validates the enum", () => {
      expect(validateSampleCreate({ text: "x", platform: "x", format: "social" }).source).toBe("manual");
      expect(validateSampleCreate({ text: "x", platform: "x", format: "social", source: "generated" }).source).toBe("generated");
      expect(() => validateSampleCreate({ text: "x", platform: "x", format: "social", source: "nope" })).toThrow(/source/);
    });

    test("requires text", () => {
      expect(() => validateSampleCreate({ text: "", platform: "x", format: "social" })).toThrow(/text/);
    });

    test("accepts content-auto as a source", () => {
      expect(validateSampleCreate({ text: "x", platform: "blog", format: "blog", source: "content-auto" }).source).toBe("content-auto");
    });

    test("accepts published_at as a date or ISO timestamp and rejects junk", () => {
      expect(validateSampleCreate({ text: "x", platform: "x", format: "social", published_at: "2026-06-01" }).publishedAt)
        .toBe("2026-06-01");
      expect(validateSampleCreate({ text: "x", platform: "x", format: "social", published_at: "2026-06-01T12:30:00Z" }).publishedAt)
        .toBe("2026-06-01T12:30:00Z");
      expect(validateSampleCreate({ text: "x", platform: "x", format: "social" }).publishedAt).toBeUndefined();
      expect(() => validateSampleCreate({ text: "x", platform: "x", format: "social", published_at: "June 1" })).toThrow(/published_at/);
      expect(() => validateSampleCreate({ text: "x", platform: "x", format: "social", published_at: "2026-13-40" })).toThrow(/published_at/);
    });
  });

  test("validatePlatform rejects unknown handles", () => {
    expect(validatePlatform("bluesky")).toBe("bluesky");
    expect(() => validatePlatform(undefined)).toThrow(/platform/);
  });

  describe("formatters map camel→snake", () => {
    test("formatVoiceDraft", () => {
      expect(formatVoiceDraft({ post: "p" })).toEqual({ post: "p", title: null });
      expect(formatVoiceDraft({ post: "p", title: "t" })).toEqual({ post: "p", title: "t" });
    });
    test("formatVoiceSample", () => {
      expect(formatVoiceSample({ sampleId: "S1", platform: "x", format: "social", source: "manual", text: "hi", createdAt: "t0" }))
        .toEqual({ sample_id: "S1", platform: "x", format: "social", source: "manual", text: "hi", published_at: null, created_at: "t0" });
      expect(formatVoiceSample({ sampleId: "S1", platform: "blog", text: "hi", publishedAt: "2026-06-01", createdAt: "t0" }).published_at)
        .toBe("2026-06-01");
    });
    test("formatVoiceProfile returns null for a missing row", () => {
      expect(formatVoiceProfile(null)).toBeNull();
      expect(formatVoiceProfile({ platform: "x", profile: { tone: "wry" }, samplesSinceReflection: 2, version: 1, updatedAt: "t1" }))
        .toMatchObject({ platform: "x", samples_since_reflection: 2, reflection_threshold: 5, recency_half_life_days: 90, version: 1, updated_at: "t1" });
    });
    test("formatVoiceReflection", () => {
      expect(formatVoiceReflection({ reflectionId: "R1", platform: "x", changeSummary: "c", sampleWindow: 5, model: "m", createdAt: "t0" }))
        .toEqual({ reflection_id: "R1", platform: "x", change_summary: "c", sample_window: 5, half_life_days: null, model: "m", created_at: "t0" });
      expect(formatVoiceReflection({ reflectionId: "R2", platform: "x", halfLifeDays: 90, createdAt: "t0" }).half_life_days).toBe(90);
    });
  });
});
