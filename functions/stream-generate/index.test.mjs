import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.USER_POOL_ID = "us-east-1_test";
process.env.USER_POOL_CLIENT_ID = "client-test";

// This handler is the security boundary: an AuthType NONE Function URL that
// verifies the Cognito id token in-process. The suite exercises auth,
// request validation (through the real validators), tenant scoping, and the
// NDJSON envelope. AWS-facing collaborators are mocked at the module edge.

const verify = jest.fn();
jest.unstable_mockModule("aws-jwt-verify", () => ({
  CognitoJwtVerifier: { create: () => ({ verify }) },
}));
jest.unstable_mockModule("../../api/services/embeddings.mjs", () => ({
  embedText: jest.fn(),
}));
jest.unstable_mockModule("../../api/services/voice-vectors.mjs", () => ({
  queryVoiceSamples: jest.fn(),
}));
jest.unstable_mockModule("../../api/services/content-vectors.mjs", () => ({
  queryContentChunks: jest.fn(),
}));
jest.unstable_mockModule("../../api/services/voice-recency.mjs", () => ({
  COMPOSE_CANDIDATE_POOL: 32,
  COMPOSE_EXAMPLE_COUNT: 4,
  rankVoiceSamples: jest.fn((candidates) => candidates),
}));
jest.unstable_mockModule("../../api/domain/voice.mjs", () => ({
  getVoiceProfile: jest.fn(),
}));
jest.unstable_mockModule("../../api/services/bedrock-stream.mjs", () => ({
  streamVoicePost: jest.fn(),
  streamBlogAnswer: jest.fn(),
}));

// The Lambda streaming runtime provides `awslambda` as a global. The fake
// passes the handler through and records the status/headers committed via
// HttpResponseStream.from on the stream itself.
globalThis.awslambda = {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: {
    from: (stream, meta) => {
      stream.meta = meta;
      return stream;
    },
  },
};

const { embedText } = await import("../../api/services/embeddings.mjs");
const { queryVoiceSamples } = await import("../../api/services/voice-vectors.mjs");
const { queryContentChunks } = await import("../../api/services/content-vectors.mjs");
const { getVoiceProfile } = await import("../../api/domain/voice.mjs");
const { streamVoicePost, streamBlogAnswer } = await import("../../api/services/bedrock-stream.mjs");
const { handler } = await import("./index.mjs");

function makeStream() {
  const chunks = [];
  return {
    chunks,
    ended: false,
    meta: null,
    write(s) { chunks.push(String(s)); },
    end() { this.ended = true; },
    events() {
      return chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

function event({ auth, body } = {}) {
  return {
    headers: auth === undefined ? {} : { authorization: auth },
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  };
}

async function* yields(...texts) {
  for (const t of texts) yield t;
}

const SUB = "tenant-sub-1";

beforeEach(() => {
  jest.clearAllMocks();
  verify.mockResolvedValue({ sub: SUB });
  embedText.mockResolvedValue([0.1, 0.2]);
  getVoiceProfile.mockResolvedValue(null);
});

describe("stream-generate auth", () => {
  test("missing Authorization header -> 401 error event, no verify call", async () => {
    const stream = makeStream();
    await handler(event({ body: { mode: "ask", question: "hi" } }), stream);

    expect(stream.meta.statusCode).toBe(401);
    expect(stream.events()).toEqual([{ type: "error", message: "Unauthorized" }]);
    expect(verify).not.toHaveBeenCalled();
    expect(stream.ended).toBe(true);
  });

  test("invalid token -> 401", async () => {
    verify.mockRejectedValue(new Error("bad signature"));
    const stream = makeStream();
    await handler(event({ auth: "Bearer bogus", body: { mode: "ask", question: "hi" } }), stream);

    expect(stream.meta.statusCode).toBe(401);
    expect(queryContentChunks).not.toHaveBeenCalled();
  });

  test("Bearer prefix is stripped before verification", async () => {
    queryContentChunks.mockResolvedValue([]);
    await handler(event({ auth: "Bearer tok-123", body: { mode: "ask", question: "hi" } }), makeStream());
    expect(verify).toHaveBeenCalledWith("tok-123");
  });

  test("raw token (no Bearer) is accepted too", async () => {
    queryContentChunks.mockResolvedValue([]);
    await handler(event({ auth: "tok-456", body: { mode: "ask", question: "hi" } }), makeStream());
    expect(verify).toHaveBeenCalledWith("tok-456");
  });
});

describe("stream-generate request validation", () => {
  test("malformed JSON body -> 400", async () => {
    const stream = makeStream();
    await handler(event({ auth: "tok", body: "{not json" }), stream);

    expect(stream.meta.statusCode).toBe(400);
    expect(stream.events()).toEqual([{ type: "error", message: "Invalid JSON body" }]);
  });

  test("unknown mode -> 400", async () => {
    const stream = makeStream();
    await handler(event({ auth: "tok", body: { mode: "summarize" } }), stream);

    expect(stream.meta.statusCode).toBe(400);
    expect(stream.events()[0].message).toMatch(/mode must be/);
  });

  test("compose body failing the real validator -> 400", async () => {
    const stream = makeStream();
    await handler(event({ auth: "tok", body: { mode: "compose", platform: "myspace", format: "social" } }), stream);

    expect(stream.meta.statusCode).toBe(400);
    expect(stream.events()[0].message).toMatch(/platform must be one of/);
  });

  test("ask body failing the real validator -> 400", async () => {
    const stream = makeStream();
    await handler(event({ auth: "tok", body: { mode: "ask", question: "" } }), stream);

    expect(stream.meta.statusCode).toBe(400);
    expect(stream.events()[0].message).toMatch(/question must be/);
  });
});

describe("stream-generate ask", () => {
  test("streams deltas then done with deduped sources, scoped to the verified sub", async () => {
    queryContentChunks.mockResolvedValue([
      { contentId: "B1", title: "One", slug: "one" },
      { contentId: "B1", title: "One", slug: "one" },
      { contentId: "B2", title: "Two", slug: "two" },
    ]);
    streamBlogAnswer.mockReturnValue(yields("Hel", "lo"));

    const stream = makeStream();
    await handler(event({ auth: "Bearer tok", body: { mode: "ask", question: "what?" } }), stream);

    // Tenant scoping comes from the token, never the request body.
    expect(queryContentChunks).toHaveBeenCalledWith(expect.objectContaining({ tenantId: SUB }));
    expect(stream.meta.statusCode).toBe(200);
    expect(stream.meta.headers["content-type"]).toBe("application/x-ndjson");
    expect(stream.events()).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      {
        type: "done",
        sources: [
          { blog_id: "B1", title: "One", slug: "one" },
          { blog_id: "B2", title: "Two", slug: "two" },
        ],
      },
    ]);
    expect(stream.ended).toBe(true);
  });

  test("no matching chunks -> fallback delta and empty sources", async () => {
    queryContentChunks.mockResolvedValue([]);
    const stream = makeStream();
    await handler(event({ auth: "tok", body: { mode: "ask", question: "what?" } }), stream);

    const events = stream.events();
    expect(events[0].type).toBe("delta");
    expect(events[1]).toEqual({ type: "done", sources: [] });
    expect(streamBlogAnswer).not.toHaveBeenCalled();
  });

  test("mid-stream failure emits a terminal error event and still ends the stream", async () => {
    queryContentChunks.mockResolvedValue([{ contentId: "B1" }]);
    // eslint-disable-next-line require-yield
    streamBlogAnswer.mockReturnValue((async function* () { throw new Error("model exploded"); })());

    const stream = makeStream();
    await handler(event({ auth: "tok", body: { mode: "ask", question: "what?" } }), stream);

    expect(stream.events()).toEqual([{ type: "error", message: "model exploded" }]);
    expect(stream.ended).toBe(true);
  });
});

describe("stream-generate compose", () => {
  test("streams the voice post scoped to the verified sub", async () => {
    queryVoiceSamples.mockResolvedValue([{ sampleId: "S1" }]);
    streamVoicePost.mockReturnValue(yields("dra", "ft"));

    const stream = makeStream();
    await handler(
      event({ auth: "tok", body: { mode: "compose", platform: "linkedin", format: "social", topic: "ai" } }),
      stream,
    );

    expect(queryVoiceSamples).toHaveBeenCalledWith(expect.objectContaining({ tenantId: SUB }));
    expect(stream.events()).toEqual([
      { type: "delta", text: "dra" },
      { type: "delta", text: "ft" },
      { type: "done" },
    ]);
  });
});
