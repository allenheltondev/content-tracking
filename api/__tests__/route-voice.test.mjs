import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

jest.unstable_mockModule("../services/idempotency.mjs", () => ({ withIdempotency: (fn) => fn }));
jest.unstable_mockModule("../services/embeddings.mjs", () => ({ embedText: jest.fn() }));
jest.unstable_mockModule("../services/voice-vectors.mjs", () => ({
  queryVoiceSamples: jest.fn(),
  deleteVoiceSample: jest.fn(),
  putVoiceSample: jest.fn(),
}));
jest.unstable_mockModule("../services/bedrock.mjs", () => ({
  composeVoicePost: jest.fn(),
  assessVoiceMatch: jest.fn(),
}));
jest.unstable_mockModule("../services/voice-memory.mjs", () => ({ runReflection: jest.fn() }));
jest.unstable_mockModule("../domain/voice.mjs", () => ({
  createVoiceSample: jest.fn(),
  deleteVoiceSampleRow: jest.fn(),
  getVoiceProfile: jest.fn(),
  listProfiles: jest.fn(),
  listReflections: jest.fn(),
  listRecentSamples: jest.fn(),
  setVoiceSampleMuted: jest.fn(),
  setVoiceSteering: jest.fn(),
}));

const { embedText } = await import("../services/embeddings.mjs");
const { queryVoiceSamples, deleteVoiceSample, putVoiceSample } = await import("../services/voice-vectors.mjs");
const { composeVoicePost, assessVoiceMatch } = await import("../services/bedrock.mjs");
const { runReflection } = await import("../services/voice-memory.mjs");
const {
  createVoiceSample, deleteVoiceSampleRow, getVoiceProfile, listProfiles, listReflections, listRecentSamples,
  setVoiceSampleMuted, setVoiceSteering,
} = await import("../domain/voice.mjs");
const { registerVoiceRoutes } = await import("../routes/voice.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    get: (p, h) => { routes[`GET ${p}`] = h; },
    post: (p, h) => { routes[`POST ${p}`] = h; },
    put: (p, h) => { routes[`PUT ${p}`] = h; },
    patch: (p, h) => { routes[`PATCH ${p}`] = h; },
    delete: (p, h) => { routes[`DELETE ${p}`] = h; },
  };
  registerVoiceRoutes(app);
  return routes;
}
const routes = buildRouteTable();
const SUB = "user-1";

function ctx({ body, params, query } = {}) {
  return {
    event: {
      body: body === undefined ? undefined : JSON.stringify(body),
      queryStringParameters: query,
      requestContext: { authorizer: { authSource: "cognito", sub: SUB } },
    },
    params,
  };
}

beforeEach(() => jest.clearAllMocks());

describe("POST /voice/compose", () => {
  test("embeds the topic, retrieves a candidate pool + profile, and composes", async () => {
    embedText.mockResolvedValue([0.1, 0.2]);
    queryVoiceSamples.mockResolvedValue([{ text: "past", distance: 0.1 }]);
    getVoiceProfile.mockResolvedValue({ profile: { tone: "wry" } });
    composeVoicePost.mockResolvedValue({ post: "Drafted.", title: null });

    const res = await routes["POST /voice/compose"](ctx({ body: { topic: "ship", platform: "x", format: "social" } }));

    expect(res.statusCode).toBe(200);
    expect(embedText).toHaveBeenCalledWith("ship");
    // Retrieves a wider pool than it uses so the recency re-rank has room.
    expect(queryVoiceSamples).toHaveBeenCalledWith({ tenantId: SUB, queryEmbedding: [0.1, 0.2], platform: "x", topK: 16 });
    expect(composeVoicePost).toHaveBeenCalledWith(expect.objectContaining({
      platform: "x", format: "social", profile: { tone: "wry" },
      samples: [expect.objectContaining({ text: "past" })],
    }));
    expect(JSON.parse(res.body).post).toBe("Drafted.");
  });

  test("re-ranks the pool by similarity + publish-date recency and caps the examples", async () => {
    embedText.mockResolvedValue([0.1]);
    const now = new Date();
    const daysAgo = (n) => new Date(now.getTime() - n * 86_400_000).toISOString();
    queryVoiceSamples.mockResolvedValue([
      { text: "stale-exact", distance: 0.05, publishedAt: daysAgo(720) },
      { text: "fresh-close", distance: 0.25, publishedAt: daysAgo(3) },
      ...Array.from({ length: 6 }, (_, i) => ({ text: `filler-${i}`, distance: 0.6, publishedAt: daysAgo(400) })),
    ]);
    getVoiceProfile.mockResolvedValue(null);
    composeVoicePost.mockResolvedValue({ post: "x" });

    await routes["POST /voice/compose"](ctx({ body: { topic: "t", platform: "x", format: "social" } }));

    const { samples } = composeVoicePost.mock.calls[0][0];
    expect(samples).toHaveLength(5);
    expect(samples[0].text).toBe("fresh-close"); // recency lifts it over the stale exact match
  });

  test("composes on a cold start (no profile)", async () => {
    embedText.mockResolvedValue([0.1]);
    queryVoiceSamples.mockResolvedValue([]);
    getVoiceProfile.mockResolvedValue(null);
    composeVoicePost.mockResolvedValue({ post: "x" });
    await routes["POST /voice/compose"](ctx({ body: { topic: "t", platform: "linkedin", format: "social" } }));
    expect(composeVoicePost).toHaveBeenCalledWith(expect.objectContaining({ profile: null, samples: [] }));
  });

  test("rejects an unknown platform before embedding", async () => {
    await expect(routes["POST /voice/compose"](ctx({ body: { topic: "t", platform: "myspace", format: "social" } })))
      .rejects.toThrow(/platform/);
    expect(embedText).not.toHaveBeenCalled();
  });
});

describe("POST /voice/check", () => {
  test("embeds the draft, retrieves ranked examples + profile, and assesses", async () => {
    embedText.mockResolvedValue([0.3]);
    queryVoiceSamples.mockResolvedValue([{ text: "past", distance: 0.1 }]);
    getVoiceProfile.mockResolvedValue({ profile: { tone: "wry" } });
    assessVoiceMatch.mockResolvedValue({
      score: 82, verdict: "on_voice", summary: "Sounds like you.",
      strengths: ["punchy opener"], issues: [], on_voice_rewrite: null,
    });

    const res = await routes["POST /voice/check"](ctx({ body: { draft: "my draft text", platform: "x", format: "social" } }));

    expect(res.statusCode).toBe(200);
    expect(embedText).toHaveBeenCalledWith("my draft text");
    expect(queryVoiceSamples).toHaveBeenCalledWith({ tenantId: SUB, queryEmbedding: [0.3], platform: "x", topK: 16 });
    expect(assessVoiceMatch).toHaveBeenCalledWith(expect.objectContaining({
      platform: "x", profile: { tone: "wry" }, draft: "my draft text",
      samples: [expect.objectContaining({ text: "past" })],
    }));
    const body = JSON.parse(res.body);
    expect(body.score).toBe(82);
    expect(body.verdict).toBe("on_voice");
    expect(body.strengths).toEqual(["punchy opener"]);
  });

  test("assesses on a cold start (no profile, no samples)", async () => {
    embedText.mockResolvedValue([0.1]);
    queryVoiceSamples.mockResolvedValue([]);
    getVoiceProfile.mockResolvedValue(null);
    assessVoiceMatch.mockResolvedValue({ score: 40, verdict: "off_voice", summary: "Hard to tell yet." });
    await routes["POST /voice/check"](ctx({ body: { draft: "d", platform: "linkedin", format: "social" } }));
    expect(assessVoiceMatch).toHaveBeenCalledWith(expect.objectContaining({ profile: null, samples: [] }));
  });

  test("requires a non-empty draft and a known platform", async () => {
    await expect(routes["POST /voice/check"](ctx({ body: { draft: "  ", platform: "x", format: "social" } })))
      .rejects.toThrow(/draft/);
    await expect(routes["POST /voice/check"](ctx({ body: { draft: "d", platform: "myspace", format: "social" } })))
      .rejects.toThrow(/platform/);
    expect(embedText).not.toHaveBeenCalled();
  });
});

describe("GET /voice/overview", () => {
  test("summarizes every profile's portrait + corpus in one call", async () => {
    listProfiles.mockResolvedValue([
      { platform: "blog", profile: { portrait: "You write like an engineer." }, version: 3, updatedAt: "t3" },
    ]);
    const now = Date.now();
    const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString();
    listRecentSamples.mockResolvedValue([
      { source: "content-auto", publishedAt: daysAgo(5) },
      { source: "content-auto", publishedAt: daysAgo(40) },
      { source: "manual", publishedAt: daysAgo(800) },
      // Held out of the voice — must not inflate totals or influence.
      { source: "content-auto", publishedAt: daysAgo(1), muted: true },
      { source: "generated", publishedAt: daysAgo(1) },
    ]);

    const res = await routes["GET /voice/overview"](ctx());

    expect(res.statusCode).toBe(200);
    expect(listRecentSamples).toHaveBeenCalledWith(SUB, "blog", 500);
    const body = JSON.parse(res.body);
    expect(body.platforms).toHaveLength(1);
    const entry = body.platforms[0];
    expect(entry.platform).toBe("blog");
    expect(entry.portrait).toBe("You write like an engineer.");
    // Muted + generated excluded from the eligible corpus, reported separately.
    expect(entry.corpus.total_samples).toBe(3);
    expect(entry.corpus.by_source).toEqual({ "content-auto": 2, manual: 1 });
    expect(entry.corpus.excluded).toEqual({ muted: 1, generated: 1 });
    // Recent posts dominate the current voice: the 30-day window's influence
    // share should exceed its raw 1/3 sample fraction. The fresh muted/generated
    // samples do NOT appear in the window.
    const h30 = entry.corpus.recent_influence.find((h) => h.window_days === 30);
    expect(h30.sample_count).toBe(1);
    expect(h30.influence_share).toBeGreaterThan(0.33);
  });

  test("returns an empty list when the tenant has no profiles", async () => {
    listProfiles.mockResolvedValue([]);
    const res = await routes["GET /voice/overview"](ctx());
    expect(JSON.parse(res.body)).toEqual({ platforms: [] });
    expect(listRecentSamples).not.toHaveBeenCalled();
  });
});

describe("POST /voice/samples", () => {
  test("creates a sample scoped to the tenant", async () => {
    createVoiceSample.mockResolvedValue({ sampleId: "S1", platform: "x", format: "social", source: "generated", text: "hi", createdAt: "t0" });
    const res = await routes["POST /voice/samples"](ctx({ body: { text: "hi", platform: "x", format: "social", source: "generated" } }));
    expect(res.statusCode).toBe(201);
    expect(createVoiceSample).toHaveBeenCalledWith(SUB, { text: "hi", platform: "x", format: "social", source: "generated" });
    expect(JSON.parse(res.body).sample_id).toBe("S1");
  });

  test("threads published_at through to the recency anchor", async () => {
    createVoiceSample.mockResolvedValue({ sampleId: "S2", platform: "x", format: "social", source: "manual", text: "hi", publishedAt: "2026-06-01", createdAt: "t0" });
    const res = await routes["POST /voice/samples"](ctx({ body: { text: "hi", platform: "x", format: "social", published_at: "2026-06-01" } }));
    expect(createVoiceSample).toHaveBeenCalledWith(SUB, expect.objectContaining({ publishedAt: "2026-06-01" }));
    expect(JSON.parse(res.body).published_at).toBe("2026-06-01");
  });
});

describe("GET/PATCH/DELETE /voice/samples", () => {
  test("GET annotates each sample with its influence share; muted/generated report 0", async () => {
    const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
    listRecentSamples.mockResolvedValue([
      { sampleId: "FRESH", platform: "x", text: "a", source: "manual", publishedAt: daysAgo(1) },
      { sampleId: "OLD", platform: "x", text: "b", source: "manual", publishedAt: daysAgo(400) },
      { sampleId: "MUTED", platform: "x", text: "c", source: "manual", publishedAt: daysAgo(2), muted: true },
      { sampleId: "GEN", platform: "x", text: "d", source: "generated", publishedAt: daysAgo(1) },
    ]);
    const res = await routes["GET /voice/samples"](ctx({ query: { platform: "x" } }));
    const byId = Object.fromEntries(JSON.parse(res.body).samples.map((s) => [s.sample_id, s]));
    expect(byId.FRESH.influence_share).toBeGreaterThan(byId.OLD.influence_share);
    expect(byId.MUTED.influence_share).toBe(0);
    expect(byId.MUTED.muted).toBe(true);
    expect(byId.GEN.influence_share).toBe(0);
    // The eligible shares (fresh + old) sum to 1.
    expect(byId.FRESH.influence_share + byId.OLD.influence_share).toBeCloseTo(1, 2);
  });

  test("PATCH muted:true drops the vector, mutes the row, and re-derives the profile", async () => {
    setVoiceSampleMuted.mockResolvedValue({ sampleId: "S1", platform: "x", text: "a", muted: true });
    const res = await routes["PATCH /voice/samples/:id"](ctx({ params: { id: "S1" }, query: { platform: "x" }, body: { muted: true } }));
    expect(res.statusCode).toBe(200);
    expect(setVoiceSampleMuted).toHaveBeenCalledWith(SUB, "x", "S1", true);
    expect(deleteVoiceSample).toHaveBeenCalledWith({ tenantId: SUB, platform: "x", sampleId: "S1" });
    expect(putVoiceSample).not.toHaveBeenCalled();
    expect(runReflection).toHaveBeenCalledWith(SUB, "x");
    expect(JSON.parse(res.body).muted).toBe(true);
  });

  test("PATCH muted:false re-embeds the sample and re-derives the profile", async () => {
    setVoiceSampleMuted.mockResolvedValue({ sampleId: "S1", platform: "x", format: "social", text: "hello", publishedAt: "2026-06-01" });
    embedText.mockResolvedValue([0.5]);
    const res = await routes["PATCH /voice/samples/:id"](ctx({ params: { id: "S1" }, query: { platform: "x" }, body: { muted: false } }));
    expect(res.statusCode).toBe(200);
    expect(setVoiceSampleMuted).toHaveBeenCalledWith(SUB, "x", "S1", false);
    expect(embedText).toHaveBeenCalledWith("hello");
    expect(putVoiceSample).toHaveBeenCalledWith(expect.objectContaining({ sampleId: "S1", embedding: [0.5], publishedAt: "2026-06-01" }));
    expect(runReflection).toHaveBeenCalledWith(SUB, "x");
  });

  test("PATCH rejects a non-boolean muted", async () => {
    await expect(routes["PATCH /voice/samples/:id"](ctx({ params: { id: "S1" }, query: { platform: "x" }, body: { muted: "yes" } })))
      .rejects.toThrow(/muted/);
  });

  test("DELETE removes the row and the vector, then re-derives the profile", async () => {
    deleteVoiceSampleRow.mockResolvedValue();
    deleteVoiceSample.mockResolvedValue();
    const res = await routes["DELETE /voice/samples/:id"](ctx({ params: { id: "S1" }, query: { platform: "x" } }));
    expect(res.statusCode).toBe(204);
    expect(deleteVoiceSampleRow).toHaveBeenCalledWith(SUB, "x", "S1");
    expect(deleteVoiceSample).toHaveBeenCalledWith({ tenantId: SUB, platform: "x", sampleId: "S1" });
    expect(runReflection).toHaveBeenCalledWith(SUB, "x");
  });

  test("a curation reflection failure does not fail the user's action", async () => {
    deleteVoiceSampleRow.mockResolvedValue();
    deleteVoiceSample.mockResolvedValue();
    runReflection.mockRejectedValue(new Error("bedrock down"));
    const res = await routes["DELETE /voice/samples/:id"](ctx({ params: { id: "S1" }, query: { platform: "x" } }));
    expect(res.statusCode).toBe(204);
  });
});

describe("profiles", () => {
  test("GET /voice/profiles lists all", async () => {
    listProfiles.mockResolvedValue([{ platform: "x", profile: {}, samplesSinceReflection: 1, version: 1 }]);
    const res = await routes["GET /voice/profiles"](ctx());
    expect(JSON.parse(res.body).profiles).toHaveLength(1);
  });

  test("GET /voice/profiles/:platform returns profile + reflections", async () => {
    getVoiceProfile.mockResolvedValue({ platform: "x", profile: { tone: "wry" }, version: 2 });
    listReflections.mockResolvedValue([{ reflectionId: "R1", platform: "x", changeSummary: "c", createdAt: "t" }]);
    const res = await routes["GET /voice/profiles/:platform"](ctx({ params: { platform: "x" } }));
    const body = JSON.parse(res.body);
    expect(body.profile.platform).toBe("x");
    expect(body.reflections).toHaveLength(1);
  });

  test("POST /voice/profiles/:platform/reflect runs the shared reflection path", async () => {
    runReflection.mockResolvedValue({ platform: "x", profile: { tone: "new" }, version: 3, samplesSinceReflection: 0 });
    const res = await routes["POST /voice/profiles/:platform/reflect"](ctx({ params: { platform: "x" } }));
    expect(runReflection).toHaveBeenCalledWith(SUB, "x");
    expect(JSON.parse(res.body).profile.version).toBe(3);
  });

  test("PUT /voice/profiles/:platform/steering sets the note and re-derives immediately", async () => {
    setVoiceSteering.mockResolvedValue({ platform: "x", steering: "be concise" });
    runReflection.mockResolvedValue({ platform: "x", profile: { tone: "tight" }, version: 4, steering: "be concise" });
    const res = await routes["PUT /voice/profiles/:platform/steering"](ctx({ params: { platform: "x" }, body: { note: "be concise" } }));
    expect(res.statusCode).toBe(200);
    expect(setVoiceSteering).toHaveBeenCalledWith(SUB, "x", "be concise");
    expect(runReflection).toHaveBeenCalledWith(SUB, "x");
    expect(JSON.parse(res.body).profile.steering).toBe("be concise");
  });

  test("PUT steering falls back to the steered row when there's nothing to reflect yet", async () => {
    setVoiceSteering.mockResolvedValue({ platform: "x", steering: "be bold" });
    runReflection.mockResolvedValue(null); // no samples yet
    getVoiceProfile.mockResolvedValue({ platform: "x", steering: "be bold" });
    const res = await routes["PUT /voice/profiles/:platform/steering"](ctx({ params: { platform: "x" }, body: { note: "be bold" } }));
    expect(JSON.parse(res.body).profile.steering).toBe("be bold");
    expect(getVoiceProfile).toHaveBeenCalledWith(SUB, "x");
  });

  test("PUT steering accepts null to clear", async () => {
    setVoiceSteering.mockResolvedValue({ platform: "x" });
    runReflection.mockResolvedValue({ platform: "x", profile: {}, version: 5 });
    const res = await routes["PUT /voice/profiles/:platform/steering"](ctx({ params: { platform: "x" }, body: { note: null } }));
    expect(res.statusCode).toBe(200);
    expect(setVoiceSteering).toHaveBeenCalledWith(SUB, "x", null);
  });
});
