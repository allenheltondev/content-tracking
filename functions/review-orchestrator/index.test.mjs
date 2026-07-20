import { jest } from "@jest/globals";

// Mock every collaborator so the suite verifies orchestration: which lenses run,
// how their output is recorded, and how the review is closed — no Bedrock,
// vectors, or DynamoDB.
jest.unstable_mockModule("../../api/domain/content.mjs", () => ({ getContent: jest.fn() }));
jest.unstable_mockModule("../../api/domain/content-review.mjs", () => ({
  claimReview: jest.fn(),
  recordSuggestions: jest.fn(),
  completeReview: jest.fn(),
}));
jest.unstable_mockModule("../../api/domain/voice.mjs", () => ({ getVoiceProfile: jest.fn() }));
jest.unstable_mockModule("../../api/services/embeddings.mjs", () => ({ embedText: jest.fn() }));
jest.unstable_mockModule("../../api/services/voice-vectors.mjs", () => ({ queryVoiceSamples: jest.fn() }));
jest.unstable_mockModule("../../api/services/voice-recency.mjs", () => ({
  COMPOSE_CANDIDATE_POOL: 16,
  COMPOSE_EXAMPLE_COUNT: 5,
  rankVoiceSamples: jest.fn((c) => c),
}));
jest.unstable_mockModule("../../api/services/review-lenses.mjs", () => ({
  runReadabilityLens: jest.fn(),
  runLlmLens: jest.fn(),
  runBrandLens: jest.fn(),
  runSummaryLens: jest.fn(),
  // real behavior: run the fn and isolate errors, matching the module.
  runLensSafely: jest.fn(async (name, fn) => {
    try { return { name, suggestions: (await fn()) ?? [], ok: true }; }
    catch { return { name, suggestions: [], ok: false }; }
  }),
}));

const { getContent } = await import("../../api/domain/content.mjs");
const { claimReview, recordSuggestions, completeReview } = await import("../../api/domain/content-review.mjs");
const { getVoiceProfile } = await import("../../api/domain/voice.mjs");
const { embedText } = await import("../../api/services/embeddings.mjs");
const { queryVoiceSamples } = await import("../../api/services/voice-vectors.mjs");
const { runReadabilityLens, runLlmLens, runBrandLens, runSummaryLens } = await import("../../api/services/review-lenses.mjs");
const { handler } = await import("./index.mjs");

const DETAIL = { tenantId: "T1", contentId: "C1", reviewId: "R1", contentVersion: "v1", platform: "blog" };
const event = (detail = DETAIL) => ({ detail });

beforeEach(() => {
  jest.clearAllMocks();
  claimReview.mockResolvedValue(true);
  getContent.mockResolvedValue({ contentMarkdown: "the draft body", updatedAt: "v1" });
  embedText.mockResolvedValue([0.1]);
  queryVoiceSamples.mockResolvedValue([{ text: "past post" }]);
  getVoiceProfile.mockResolvedValue({ profile: { portrait: "plain" } });
  runReadabilityLens.mockResolvedValue([{ type: "grammar", textToReplace: "a", replaceWith: "b", reason: "r", priority: "low" }]);
  runLlmLens.mockResolvedValue([{ type: "llm", textToReplace: "c", replaceWith: "d", reason: "r", priority: "low" }]);
  runBrandLens.mockResolvedValue([{ type: "brand", textToReplace: "e", replaceWith: "f", reason: "r", priority: "low" }]);
  recordSuggestions.mockResolvedValue([{ suggestionId: "s1" }, { suggestionId: "s2" }, { suggestionId: "s3" }]);
  runSummaryLens.mockResolvedValue({ verdict: "minor_revisions", summary: "Good, small fixes." });
  completeReview.mockResolvedValue({});
});

test("runs all lenses, records the combined suggestions, and completes the review succeeded", async () => {
  await handler(event());

  expect(runReadabilityLens).toHaveBeenCalled();
  expect(runLlmLens).toHaveBeenCalled();
  expect(runBrandLens).toHaveBeenCalledWith(expect.objectContaining({
    body: "the draft body", tenantId: "T1", platform: "blog", profile: { portrait: "plain" },
  }));

  const recordArgs = recordSuggestions.mock.calls[0];
  expect(recordArgs[0]).toBe("T1");
  expect(recordArgs[1]).toBe("C1");
  expect(recordArgs[2].suggestions).toHaveLength(3); // grammar + llm + brand
  expect(recordArgs[2]).toMatchObject({ reviewId: "R1", contentVersion: "v1", body: "the draft body" });

  const complete = completeReview.mock.calls[0];
  expect(complete.slice(0, 3)).toEqual(["T1", "C1", "R1"]);
  expect(complete[3]).toMatchObject({ status: "succeeded", summary: "Good, small fixes." });
  expect(complete[3].lenses.verdict).toBe("minor_revisions");
  expect(complete[3].lenses.recorded).toBe(3);
});

test("no-ops on a duplicate delivery it can't claim", async () => {
  claimReview.mockResolvedValue(false);

  await handler(event());

  expect(claimReview).toHaveBeenCalledWith("T1", "C1", "R1");
  expect(getContent).not.toHaveBeenCalled();
  expect(recordSuggestions).not.toHaveBeenCalled();
  expect(completeReview).not.toHaveBeenCalled();
});

test("skips the brand lens when the tenant has no voice yet", async () => {
  getVoiceProfile.mockResolvedValue(null);
  queryVoiceSamples.mockResolvedValue([]);

  await handler(event());

  expect(runBrandLens).not.toHaveBeenCalled();
  expect(recordSuggestions.mock.calls[0][2].suggestions).toHaveLength(2); // grammar + llm only
  expect(completeReview.mock.calls[0][3].status).toBe("succeeded");
});

test("a single lens failure degrades but still completes the review", async () => {
  runLlmLens.mockRejectedValue(new Error("bedrock throttled"));

  await handler(event());

  const complete = completeReview.mock.calls[0][3];
  expect(complete.status).toBe("succeeded");
  expect(complete.lenses.failed).toContain("llm");
  // grammar + brand recorded, llm contributed nothing
  expect(recordSuggestions.mock.calls[0][2].suggestions).toHaveLength(2);
});

test("still completes succeeded when the summary lens fails", async () => {
  runSummaryLens.mockRejectedValue(new Error("summary failed"));
  await handler(event());
  const complete = completeReview.mock.calls[0][3];
  expect(complete.status).toBe("succeeded");
  expect(complete.summary).toBeNull();
});

test("a fatal error marks the review failed and rethrows for the DLQ", async () => {
  getContent.mockRejectedValue(new Error("content gone"));

  await expect(handler(event())).rejects.toThrow("content gone");
  expect(completeReview).toHaveBeenCalledWith("T1", "C1", "R1", expect.objectContaining({ status: "failed" }));
  expect(recordSuggestions).not.toHaveBeenCalled();
});

test("ignores an event missing identifiers", async () => {
  await handler(event({ contentId: "C1" }));
  expect(getContent).not.toHaveBeenCalled();
});
