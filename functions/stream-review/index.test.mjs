import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.USER_POOL_ID = "us-east-1_test";
process.env.USER_POOL_CLIENT_ID = "client-test";

// Security-boundary suite for the live-review Function URL (AuthType NONE,
// in-process Cognito verification). Covers auth, validation, the pre-stream
// 404/400 gates, and the NDJSON envelope around the shared review engine.

const verify = jest.fn();
jest.unstable_mockModule("aws-jwt-verify", () => ({
  CognitoJwtVerifier: { create: () => ({ verify }) },
}));
jest.unstable_mockModule("../../api/domain/content.mjs", () => ({
  getContent: jest.fn(),
}));
jest.unstable_mockModule("../../api/domain/content-review.mjs", () => ({
  createReview: jest.fn(),
}));
jest.unstable_mockModule("../../api/services/review-runner.mjs", () => ({
  runReview: jest.fn(),
}));

globalThis.awslambda = {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: {
    from: (stream, meta) => {
      stream.meta = meta;
      return stream;
    },
  },
};

const { getContent } = await import("../../api/domain/content.mjs");
const { createReview } = await import("../../api/domain/content-review.mjs");
const { runReview } = await import("../../api/services/review-runner.mjs");
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

const SUB = "tenant-sub-1";
const CONTENT = { contentId: "C1", contentMarkdown: "# body", updatedAt: "2026-07-01T00:00:00.000Z" };
const REVIEW = {
  reviewId: "R1",
  status: "running",
  createdAt: "2026-07-01T00:00:01.000Z",
  updatedAt: "2026-07-01T00:00:01.000Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  verify.mockResolvedValue({ sub: SUB });
  getContent.mockResolvedValue(CONTENT);
  createReview.mockResolvedValue(REVIEW);
  runReview.mockResolvedValue();
});

describe("stream-review auth", () => {
  test("missing Authorization -> 401, nothing touched", async () => {
    const stream = makeStream();
    await handler(event({ body: { contentId: "C1" } }), stream);

    expect(stream.meta.statusCode).toBe(401);
    expect(stream.events()).toEqual([{ type: "error", message: "Unauthorized" }]);
    expect(getContent).not.toHaveBeenCalled();
    expect(stream.ended).toBe(true);
  });

  test("invalid token -> 401", async () => {
    verify.mockRejectedValue(new Error("expired"));
    const stream = makeStream();
    await handler(event({ auth: "Bearer bogus", body: { contentId: "C1" } }), stream);

    expect(stream.meta.statusCode).toBe(401);
    expect(createReview).not.toHaveBeenCalled();
  });

  test("Bearer and raw tokens are both accepted", async () => {
    await handler(event({ auth: "Bearer tok-1", body: { contentId: "C1" } }), makeStream());
    expect(verify).toHaveBeenCalledWith("tok-1");

    await handler(event({ auth: "tok-2", body: { contentId: "C1" } }), makeStream());
    expect(verify).toHaveBeenCalledWith("tok-2");
  });
});

describe("stream-review validation and pre-stream gates", () => {
  test("malformed JSON -> 400", async () => {
    const stream = makeStream();
    await handler(event({ auth: "tok", body: "{oops" }), stream);

    expect(stream.meta.statusCode).toBe(400);
    expect(stream.events()).toEqual([{ type: "error", message: "Invalid JSON body" }]);
  });

  test("missing contentId -> 400", async () => {
    const stream = makeStream();
    await handler(event({ auth: "tok", body: {} }), stream);

    expect(stream.meta.statusCode).toBe(400);
    expect(stream.events()[0].message).toMatch(/contentId is required/);
  });

  test("content lookup failure -> 404 before any stream commits", async () => {
    getContent.mockRejectedValue(new Error("Content C1 not found"));
    const stream = makeStream();
    await handler(event({ auth: "tok", body: { contentId: "C1" } }), stream);

    expect(stream.meta.statusCode).toBe(404);
    expect(stream.events()).toEqual([{ type: "error", message: "Content not found" }]);
    expect(createReview).not.toHaveBeenCalled();
  });

  test("content with no body -> 400", async () => {
    getContent.mockResolvedValue({ ...CONTENT, contentMarkdown: "   " });
    const stream = makeStream();
    await handler(event({ auth: "tok", body: { contentId: "C1" } }), stream);

    expect(stream.meta.statusCode).toBe(400);
    expect(stream.events()[0].message).toMatch(/no body to review/);
  });
});

describe("stream-review happy path", () => {
  test("emits the created review then runs the engine scoped to the verified sub", async () => {
    runReview.mockImplementation(async ({ emit }) => {
      emit({ type: "status", lens: "clarity", state: "running" });
      emit({ type: "done", status: "succeeded" });
    });

    const stream = makeStream();
    await handler(event({ auth: "Bearer tok", body: { contentId: "C1", platform: "blog" } }), stream);

    // Ownership comes from the token: content read and review rows are keyed
    // by the verified sub, never a caller-supplied tenant.
    expect(getContent).toHaveBeenCalledWith(SUB, "C1");
    expect(createReview).toHaveBeenCalledWith(SUB, "C1", { contentVersion: CONTENT.updatedAt });
    expect(runReview).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: SUB,
      contentId: "C1",
      reviewId: "R1",
      platform: "blog",
    }));

    expect(stream.meta.statusCode).toBe(200);
    expect(stream.meta.headers["content-type"]).toBe("application/x-ndjson");
    const events = stream.events();
    expect(events[0]).toEqual({
      type: "review",
      review: expect.objectContaining({ id: "R1", status: "running" }),
    });
    expect(events[1]).toEqual({ type: "status", lens: "clarity", state: "running" });
    expect(events[2]).toEqual({ type: "done", status: "succeeded" });
    expect(stream.ended).toBe(true);
  });

  test("engine failure mid-stream still closes the stream without throwing", async () => {
    runReview.mockRejectedValue(new Error("lens crashed"));

    const stream = makeStream();
    await handler(event({ auth: "tok", body: { contentId: "C1" } }), stream);

    // runReview owns emitting the terminal error event; the handler just
    // logs and closes. The stream must end either way.
    expect(stream.ended).toBe(true);
    expect(stream.meta.statusCode).toBe(200);
  });
});
