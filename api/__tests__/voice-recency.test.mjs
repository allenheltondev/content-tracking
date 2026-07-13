// The recency model is the scientific core of voice evolution — pin its math
// exactly: exponential half-life decay, window selection, share normalization,
// and the similarity/recency blend used to pick compose examples.

const {
  recencyWeight,
  effectiveSampleDate,
  selectRecencyWeighted,
  rankVoiceSamples,
  voiceHalfLifeDays,
  voiceRecencyBlend,
  COMPOSE_CANDIDATE_POOL,
  COMPOSE_EXAMPLE_COUNT,
} = await import("../services/voice-recency.mjs");

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-13T00:00:00.000Z");

describe("recencyWeight", () => {
  test("today = 1, one half-life = 0.5, two half-lives = 0.25", () => {
    const opts = { now: NOW, halfLifeDays: 90 };
    expect(recencyWeight(new Date(NOW).toISOString(), opts)).toBeCloseTo(1, 10);
    expect(recencyWeight(new Date(NOW - 90 * DAY).toISOString(), opts)).toBeCloseTo(0.5, 10);
    expect(recencyWeight(new Date(NOW - 180 * DAY).toISOString(), opts)).toBeCloseTo(0.25, 10);
  });

  test("accepts plain YYYY-MM-DD dates", () => {
    expect(recencyWeight("2026-07-13", { now: NOW, halfLifeDays: 90 })).toBeCloseTo(1, 5);
  });

  test("future dates (scheduled posts) clamp to 1", () => {
    expect(recencyWeight(new Date(NOW + 30 * DAY).toISOString(), { now: NOW })).toBe(1);
  });

  test("missing or unparseable dates get the neutral half weight", () => {
    expect(recencyWeight(undefined, { now: NOW })).toBe(0.5);
    expect(recencyWeight("not-a-date", { now: NOW })).toBe(0.5);
  });
});

describe("effectiveSampleDate", () => {
  test("prefers publishedAt, falls back to createdAt", () => {
    expect(effectiveSampleDate({ publishedAt: "p", createdAt: "c" })).toBe("p");
    expect(effectiveSampleDate({ createdAt: "c" })).toBe("c");
    expect(effectiveSampleDate({})).toBeNull();
  });
});

describe("selectRecencyWeighted", () => {
  const samples = [
    { text: "ancient", publishedAt: new Date(NOW - 720 * DAY).toISOString() },
    { text: "fresh", publishedAt: new Date(NOW - 1 * DAY).toISOString() },
    { text: "mid", publishedAt: new Date(NOW - 90 * DAY).toISOString() },
  ];

  test("orders newest-published first regardless of input order", () => {
    const out = selectRecencyWeighted(samples, { now: NOW });
    expect(out.map((s) => s.text)).toEqual(["fresh", "mid", "ancient"]);
  });

  test("windows to the limit and normalizes weight shares over the window", () => {
    const out = selectRecencyWeighted(samples, { now: NOW, limit: 2 });
    expect(out.map((s) => s.text)).toEqual(["fresh", "mid"]);
    expect(out.reduce((acc, s) => acc + s.weightShare, 0)).toBeCloseTo(1, 10);
    expect(out[0].weightShare).toBeGreaterThan(out[1].weightShare);
  });

  test("a recent post outweighs an old one exponentially, not linearly", () => {
    const [fresh, , ancient] = selectRecencyWeighted(samples, { now: NOW, halfLifeDays: 90 });
    // 720 days = 8 half-lives => ~2^8 ratio between fresh and ancient.
    expect(fresh.recencyWeight / ancient.recencyWeight).toBeGreaterThan(100);
  });

  test("handles empty input", () => {
    expect(selectRecencyWeighted([], {})).toEqual([]);
    expect(selectRecencyWeighted(undefined, {})).toEqual([]);
  });
});

describe("rankVoiceSamples", () => {
  test("blends similarity with recency: a recent near-match beats a stale exact match", () => {
    const candidates = [
      { text: "stale-exact", distance: 0.05, publishedAt: new Date(NOW - 720 * DAY).toISOString() },
      { text: "fresh-close", distance: 0.25, publishedAt: new Date(NOW - 5 * DAY).toISOString() },
    ];
    const out = rankVoiceSamples(candidates, { now: NOW, halfLifeDays: 90, blend: 0.35, topK: 2 });
    expect(out[0].text).toBe("fresh-close");
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  test("with blend 0 it is pure similarity ranking (the legacy behavior)", () => {
    const candidates = [
      { text: "far", distance: 0.9, publishedAt: new Date(NOW).toISOString() },
      { text: "near", distance: 0.1, publishedAt: new Date(NOW - 720 * DAY).toISOString() },
    ];
    const out = rankVoiceSamples(candidates, { now: NOW, blend: 0, topK: 2 });
    expect(out[0].text).toBe("near");
  });

  test("slices to topK after scoring", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      text: `s${i}`, distance: 0.1 * i, publishedAt: new Date(NOW).toISOString(),
    }));
    expect(rankVoiceSamples(candidates, { now: NOW, topK: 3 })).toHaveLength(3);
  });

  test("legacy vectors without publishedAt still rank via the neutral weight", () => {
    const out = rankVoiceSamples([{ text: "legacy", distance: 0.2 }], { now: NOW, topK: 1 });
    expect(out[0].recencyWeight).toBe(0.5);
    expect(out[0].similarity).toBeCloseTo(0.8, 10);
  });

  test("similarity clamps for out-of-range cosine distances", () => {
    const out = rankVoiceSamples(
      [{ text: "opposite", distance: 1.8, publishedAt: new Date(NOW).toISOString() }],
      { now: NOW, topK: 1 },
    );
    expect(out[0].similarity).toBe(0);
  });
});

describe("configuration", () => {
  test("defaults: 90-day half-life, 0.35 blend, 16→5 compose funnel", () => {
    expect(voiceHalfLifeDays()).toBe(90);
    expect(voiceRecencyBlend()).toBe(0.35);
    expect(COMPOSE_CANDIDATE_POOL).toBe(16);
    expect(COMPOSE_EXAMPLE_COUNT).toBe(5);
  });
});
