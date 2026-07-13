import {
  validateComposeRequest,
  validateSampleCreate,
  validateSampleUpdate,
  validateSteeringRequest,
  validateVoiceCheckRequest,
  validatePlatform,
  formatVoiceDraft,
  formatVoiceSample,
  formatVoiceProfile,
  formatVoiceReflection,
  formatVoiceOverviewEntry,
  formatVoiceAssessment,
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

  describe("validateVoiceCheckRequest", () => {
    test("accepts a draft with platform + format", () => {
      expect(validateVoiceCheckRequest({ draft: "some text", platform: "x", format: "social" }))
        .toEqual({ draft: "some text", platform: "x", format: "social" });
    });
    test("requires a non-empty draft and a known platform", () => {
      expect(() => validateVoiceCheckRequest({ draft: "  ", platform: "x", format: "social" })).toThrow(/draft/);
      expect(() => validateVoiceCheckRequest({ draft: "d", platform: "myspace", format: "social" })).toThrow(/platform/);
    });
    test("pins platform=blog to format=blog", () => {
      expect(() => validateVoiceCheckRequest({ draft: "d", platform: "blog", format: "social" })).toThrow(/requires format "blog"/);
    });
  });

  describe("validateSampleUpdate", () => {
    test("accepts a boolean muted", () => {
      expect(validateSampleUpdate({ muted: true })).toEqual({ muted: true });
      expect(validateSampleUpdate({ muted: false })).toEqual({ muted: false });
    });
    test("rejects a non-boolean muted", () => {
      expect(() => validateSampleUpdate({ muted: "yes" })).toThrow(/muted/);
      expect(() => validateSampleUpdate({})).toThrow(/muted/);
    });
  });

  describe("validateSteeringRequest", () => {
    test("accepts a note and trims it", () => {
      expect(validateSteeringRequest({ note: "  be concise  " })).toEqual({ note: "be concise" });
    });
    test("accepts null to clear", () => {
      expect(validateSteeringRequest({ note: null })).toEqual({ note: null });
    });
    test("rejects an empty or over-long note", () => {
      expect(() => validateSteeringRequest({ note: "  " })).toThrow(/note/);
      expect(() => validateSteeringRequest({ note: "x".repeat(501) })).toThrow(/note/);
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
        .toEqual({ sample_id: "S1", platform: "x", format: "social", source: "manual", text: "hi", published_at: null, created_at: "t0", muted: false, influence_share: null });
      expect(formatVoiceSample({ sampleId: "S1", platform: "blog", text: "hi", publishedAt: "2026-06-01", createdAt: "t0" }).published_at)
        .toBe("2026-06-01");
    });
    test("formatVoiceSample surfaces muted + rounded influence share", () => {
      const out = formatVoiceSample({ sampleId: "S1", platform: "x", text: "hi", muted: true, createdAt: "t0" }, { influenceShare: 0.4123 });
      expect(out.muted).toBe(true);
      expect(out.influence_share).toBe(0.41);
    });
    test("formatVoiceProfile returns null for a missing row", () => {
      expect(formatVoiceProfile(null)).toBeNull();
      expect(formatVoiceProfile({ platform: "x", profile: { tone: "wry" }, samplesSinceReflection: 2, version: 1, updatedAt: "t1" }))
        .toMatchObject({ platform: "x", samples_since_reflection: 2, reflection_threshold: 5, recency_half_life_days: 90, version: 1, updated_at: "t1" });
    });
    test("formatVoiceProfile surfaces the portrait at the top level", () => {
      expect(formatVoiceProfile({ platform: "x", profile: { portrait: "You write plainly." } }).portrait)
        .toBe("You write plainly.");
      expect(formatVoiceProfile({ platform: "x", profile: { tone: "wry" } }).portrait).toBeNull();
      expect(formatVoiceProfile({ platform: "x", profile: null }).portrait).toBeNull();
    });
    test("formatVoiceOverviewEntry maps portrait + corpus summary", () => {
      const entry = formatVoiceOverviewEntry({
        profileRow: { platform: "blog", profile: { portrait: "You write like an engineer." }, version: 3, updatedAt: "t3", samplesSinceReflection: 1 },
        summary: {
          total: 12,
          bySource: { "content-auto": 10, manual: 2 },
          excluded: { muted: 1, generated: 2 },
          earliestPublished: "2024-01-01T00:00:00.000Z",
          latestPublished: "2026-07-01T00:00:00.000Z",
          recentInfluence: [{ windowDays: 30, share: 0.4123, sampleCount: 3 }],
        },
      });
      expect(entry).toMatchObject({
        platform: "blog",
        portrait: "You write like an engineer.",
        version: 3,
        reflection_threshold: 5,
        recency_half_life_days: 90,
        corpus: {
          total_samples: 12,
          by_source: { "content-auto": 10, manual: 2 },
          excluded: { muted: 1, generated: 2 },
          earliest_published: "2024-01-01T00:00:00.000Z",
          latest_published: "2026-07-01T00:00:00.000Z",
          recent_influence: [{ window_days: 30, influence_share: 0.41, sample_count: 3 }],
        },
      });
    });
    test("formatVoiceAssessment maps score/verdict/issues and defaults", () => {
      expect(formatVoiceAssessment({ score: 90, verdict: "on_voice", summary: "s" }))
        .toEqual({ score: 90, verdict: "on_voice", summary: "s", strengths: [], issues: [], on_voice_rewrite: null });
      const full = formatVoiceAssessment({
        score: 60, verdict: "close", summary: "s",
        strengths: ["a"], issues: [{ area: "tone", detail: "d", suggestion: "fix" }], on_voice_rewrite: "rewritten",
      });
      expect(full.issues).toEqual([{ area: "tone", detail: "d", suggestion: "fix" }]);
      expect(full.on_voice_rewrite).toBe("rewritten");
    });
    test("formatVoiceReflection", () => {
      expect(formatVoiceReflection({ reflectionId: "R1", platform: "x", changeSummary: "c", sampleWindow: 5, model: "m", createdAt: "t0" }))
        .toEqual({ reflection_id: "R1", platform: "x", change_summary: "c", sample_window: 5, half_life_days: null, version: null, portrait: null, model: "m", created_at: "t0" });
      const snap = formatVoiceReflection({ reflectionId: "R2", platform: "x", halfLifeDays: 90, version: 7, portrait: "You write plainly.", createdAt: "t0" });
      expect(snap.half_life_days).toBe(90);
      expect(snap.version).toBe(7);
      expect(snap.portrait).toBe("You write plainly.");
    });
  });
});
