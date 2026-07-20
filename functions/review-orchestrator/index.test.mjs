import { jest } from "@jest/globals";

// The orchestrator is a thin async entry point over the shared runner; the
// engine behavior is covered in api/__tests__/review-runner.test.mjs.
jest.unstable_mockModule("../../api/services/review-runner.mjs", () => ({ runReview: jest.fn() }));

const { runReview } = await import("../../api/services/review-runner.mjs");
const { handler } = await import("./index.mjs");

const DETAIL = { tenantId: "T1", contentId: "C1", reviewId: "R1", contentVersion: "v1", platform: "blog" };

beforeEach(() => jest.clearAllMocks());

test("delegates to the shared runner with the event detail", async () => {
  runReview.mockResolvedValue(undefined);
  await handler({ detail: DETAIL });
  expect(runReview).toHaveBeenCalledWith(DETAIL);
});

test("ignores an event missing identifiers", async () => {
  await handler({ detail: { contentId: "C1" } });
  expect(runReview).not.toHaveBeenCalled();
});

test("propagates a fatal error so the async invocation lands in the DLQ", async () => {
  runReview.mockRejectedValue(new Error("boom"));
  await expect(handler({ detail: DETAIL })).rejects.toThrow("boom");
});
