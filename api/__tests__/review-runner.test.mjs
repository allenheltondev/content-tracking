import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
delete process.env.FACT_SEARCH_URL;

jest.unstable_mockModule("../domain/content.mjs", () => ({ getContent: jest.fn() }));
jest.unstable_mockModule("../domain/content-review.mjs", () => ({
  claimReview: jest.fn(),
  completeReview: jest.fn(),
  getReview: jest.fn(),
  listSuggestions: jest.fn(),
  recordSuggestions: jest.fn(),
}));
jest.unstable_mockModule("../domain/voice.mjs", () => ({ getVoiceProfile: jest.fn() }));
jest.unstable_mockModule("../services/embeddings.mjs", () => ({ embedText: jest.fn() }));
jest.unstable_mockModule("../services/voice-vectors.mjs", () => ({ queryVoiceSamples: jest.fn() }));
jest.unstable_mockModule("../services/voice-recency.mjs", () => ({
  COMPOSE_CANDIDATE_POOL: 16,
  COMPOSE_EXAMPLE_COUNT: 5,
  rankVoiceSamples: jest.fn((c) => c),
}));
jest.unstable_mockModule("../services/review-lenses.mjs", () => ({
  runReadabilityLens: jest.fn(),
  runLlmLens: jest.fn(),
  runBrandLens: jest.fn(),
  runFactLens: jest.fn(),
  runSummaryLens: jest.fn(),
  runLensSafely: jest.fn(async (name, fn) => {
    try { return { name, suggestions: (await fn()) ?? [], ok: true }; }
    catch { return { name, suggestions: [], ok: false }; }
  }),
}));

const { getContent } = await import("../domain/content.mjs");
const { claimReview, completeReview, getReview, listSuggestions, recordSuggestions } = await import("../domain/content-review.mjs");
const { getVoiceProfile } = await import("../domain/voice.mjs");
const { embedText } = await import("../services/embeddings.mjs");
const { queryVoiceSamples } = await import("../services/voice-vectors.mjs");
const { runReadabilityLens, runLlmLens, runBrandLens, runFactLens, runSummaryLens } = await import("../services/review-lenses.mjs");
const { runReview } = await import("../services/review-runner.mjs");

const BASE = { tenantId: "T1", contentId: "C1", reviewId: "R1", contentVersion: "v1", platform: "blog" };

function recordedRow(id, type) {
  return {
    suggestionId: id, reviewId: "R1", type, priority: "low", reason: "r", status: "pending",
    startOffset: 0, endOffset: 1, anchorText: "x", replaceWith: "y", contextBefore: "", contextAfter: "", createdAt: "t",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FACT_SEARCH_URL;
  claimReview.mockResolvedValue(true);
  getContent.mockResolvedValue({ contentMarkdown: "the draft", updatedAt: "v1" });
  embedText.mockResolvedValue([0.1]);
  queryVoiceSamples.mockResolvedValue([{ text: "past" }]);
  getVoiceProfile.mockResolvedValue({ profile: { portrait: "plain" } });
  runReadabilityLens.mockResolvedValue([{ type: "grammar" }]);
  runLlmLens.mockResolvedValue([{ type: "llm" }]);
  runBrandLens.mockResolvedValue([{ type: "brand" }]);
  runSummaryLens.mockResolvedValue({ verdict: "minor_revisions", summary: "Good." });
  recordSuggestions.mockResolvedValue([recordedRow("s1", "grammar"), recordedRow("s2", "llm"), recordedRow("s3", "brand")]);
  completeReview.mockResolvedValue({});
});

test("claims, runs the lenses, records, completes, and emits the event stream", async () => {
  const events = [];
  await runReview({ ...BASE, emit: (e) => events.push(e) });

  expect(claimReview).toHaveBeenCalledWith("T1", "C1", "R1");
  expect(runReadabilityLens).toHaveBeenCalled();
  expect(runBrandLens).toHaveBeenCalledWith(expect.objectContaining({ platform: "blog", profile: { portrait: "plain" } }));
  expect(runFactLens).not.toHaveBeenCalled(); // no FACT_SEARCH_URL

  expect(recordSuggestions.mock.calls[0][2].suggestions).toHaveLength(3);
  expect(completeReview.mock.calls[0][3]).toMatchObject({ status: "succeeded", summary: "Good." });

  // The stream: a status + lens event per lens, then suggestions, summary, done.
  const types = events.map((e) => e.type);
  expect(types).toContain("status");
  expect(types).toContain("lens");
  const sug = events.find((e) => e.type === "suggestions");
  expect(sug.suggestions).toHaveLength(3);
  expect(sug.suggestions[0]).toMatchObject({ id: "s1", type: "grammar" }); // snake_case DTO via formatSuggestion
  expect(events.at(-1)).toEqual({ type: "done", status: "succeeded" });
});

test("includes the fact lens when a search provider is configured", async () => {
  process.env.FACT_SEARCH_URL = "https://search.example/api";
  runFactLens.mockResolvedValue([{ type: "fact" }]);
  recordSuggestions.mockResolvedValue([recordedRow("s1", "grammar")]);

  await runReview({ ...BASE });
  expect(runFactLens).toHaveBeenCalledWith(expect.objectContaining({ search: expect.objectContaining({ url: "https://search.example/api" }) }));
});

test("skips the brand lens when the tenant has no voice", async () => {
  getVoiceProfile.mockResolvedValue(null);
  queryVoiceSamples.mockResolvedValue([]);
  await runReview({ ...BASE });
  expect(runBrandLens).not.toHaveBeenCalled();
  expect(recordSuggestions.mock.calls[0][2].suggestions).toHaveLength(2);
});

test("a lens failure degrades but still completes the review", async () => {
  runLlmLens.mockRejectedValue(new Error("throttled"));
  await runReview({ ...BASE });
  expect(completeReview.mock.calls[0][3].lenses.failed).toContain("llm");
  expect(completeReview.mock.calls[0][3].status).toBe("succeeded");
});

test("a lost claim streams the existing suggestions instead of re-running", async () => {
  claimReview.mockResolvedValue(false);
  listSuggestions.mockResolvedValue([recordedRow("s1", "grammar")]);
  getReview.mockResolvedValue({ reviewId: "R1", status: "running", summary: null, lenses: null, createdAt: "t", updatedAt: "t" });

  const events = [];
  await runReview({ ...BASE, emit: (e) => events.push(e) });

  expect(getContent).not.toHaveBeenCalled();
  expect(recordSuggestions).not.toHaveBeenCalled();
  expect(events.find((e) => e.type === "suggestions").suggestions).toHaveLength(1);
  expect(events.at(-1).type).toBe("done");
});

test("a fatal error marks the review failed, emits error, and rethrows", async () => {
  getContent.mockRejectedValue(new Error("gone"));
  const events = [];
  await expect(runReview({ ...BASE, emit: (e) => events.push(e) })).rejects.toThrow("gone");
  expect(completeReview).toHaveBeenCalledWith("T1", "C1", "R1", expect.objectContaining({ status: "failed" }));
  expect(events.at(-1)).toEqual({ type: "error", message: "The review could not be completed." });
});
