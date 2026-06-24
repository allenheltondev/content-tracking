import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

jest.unstable_mockModule("../services/idempotency.mjs", () => ({ withIdempotency: (fn) => fn }));
jest.unstable_mockModule("../services/embeddings.mjs", () => ({ embedText: jest.fn() }));
jest.unstable_mockModule("../services/voice-vectors.mjs", () => ({
  queryVoiceSamples: jest.fn(),
  deleteVoiceSample: jest.fn(),
}));
jest.unstable_mockModule("../services/bedrock.mjs", () => ({ composeVoicePost: jest.fn() }));
jest.unstable_mockModule("../services/voice-memory.mjs", () => ({ runReflection: jest.fn() }));
jest.unstable_mockModule("../domain/voice.mjs", () => ({
  createVoiceSample: jest.fn(),
  deleteVoiceSampleRow: jest.fn(),
  getVoiceProfile: jest.fn(),
  listProfiles: jest.fn(),
  listReflections: jest.fn(),
  listRecentSamples: jest.fn(),
}));

const { embedText } = await import("../services/embeddings.mjs");
const { queryVoiceSamples, deleteVoiceSample } = await import("../services/voice-vectors.mjs");
const { composeVoicePost } = await import("../services/bedrock.mjs");
const { runReflection } = await import("../services/voice-memory.mjs");
const {
  createVoiceSample, deleteVoiceSampleRow, getVoiceProfile, listProfiles, listReflections, listRecentSamples,
} = await import("../domain/voice.mjs");
const { registerVoiceRoutes } = await import("../routes/voice.mjs");

function buildRouteTable() {
  const routes = {};
  const app = {
    get: (p, h) => { routes[`GET ${p}`] = h; },
    post: (p, h) => { routes[`POST ${p}`] = h; },
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
  test("embeds the topic, retrieves platform samples + profile, and composes", async () => {
    embedText.mockResolvedValue([0.1, 0.2]);
    queryVoiceSamples.mockResolvedValue([{ text: "past" }]);
    getVoiceProfile.mockResolvedValue({ profile: { tone: "wry" } });
    composeVoicePost.mockResolvedValue({ post: "Drafted.", title: null });

    const res = await routes["POST /voice/compose"](ctx({ body: { topic: "ship", platform: "x", format: "social" } }));

    expect(res.statusCode).toBe(200);
    expect(embedText).toHaveBeenCalledWith("ship");
    expect(queryVoiceSamples).toHaveBeenCalledWith({ tenantId: SUB, queryEmbedding: [0.1, 0.2], platform: "x" });
    expect(composeVoicePost).toHaveBeenCalledWith(expect.objectContaining({
      platform: "x", format: "social", profile: { tone: "wry" }, samples: [{ text: "past" }],
    }));
    expect(JSON.parse(res.body).post).toBe("Drafted.");
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

describe("POST /voice/samples", () => {
  test("creates a sample scoped to the tenant", async () => {
    createVoiceSample.mockResolvedValue({ sampleId: "S1", platform: "x", format: "social", source: "generated", text: "hi", createdAt: "t0" });
    const res = await routes["POST /voice/samples"](ctx({ body: { text: "hi", platform: "x", format: "social", source: "generated" } }));
    expect(res.statusCode).toBe(201);
    expect(createVoiceSample).toHaveBeenCalledWith(SUB, { text: "hi", platform: "x", format: "social", source: "generated" });
    expect(JSON.parse(res.body).sample_id).toBe("S1");
  });
});

describe("GET/DELETE /voice/samples", () => {
  test("GET requires platform and lists recent samples", async () => {
    listRecentSamples.mockResolvedValue([{ sampleId: "S1", platform: "x", text: "a", createdAt: "t" }]);
    const res = await routes["GET /voice/samples"](ctx({ query: { platform: "x" } }));
    expect(listRecentSamples).toHaveBeenCalledWith(SUB, "x");
    expect(JSON.parse(res.body).samples).toHaveLength(1);
  });

  test("DELETE removes the row and the vector", async () => {
    deleteVoiceSampleRow.mockResolvedValue();
    deleteVoiceSample.mockResolvedValue();
    const res = await routes["DELETE /voice/samples/:id"](ctx({ params: { id: "S1" }, query: { platform: "x" } }));
    expect(res.statusCode).toBe(204);
    expect(deleteVoiceSampleRow).toHaveBeenCalledWith(SUB, "x", "S1");
    expect(deleteVoiceSample).toHaveBeenCalledWith({ tenantId: SUB, platform: "x", sampleId: "S1" });
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
});
