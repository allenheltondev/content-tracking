import { jest } from "@jest/globals";

const sendMock = jest.fn();
jest.unstable_mockModule("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: jest.fn(() => ({ send: sendMock })),
  PutEventsCommand: jest.fn((input) => ({ input })),
}));

const { emitStartReview, REVIEW_EVENT_SOURCE, START_REVIEW_DETAIL_TYPE } = await import("../services/review-events.mjs");

beforeEach(() => {
  sendMock.mockReset();
});

test("emits a Start Content Review event with the review context", async () => {
  sendMock.mockResolvedValue({ FailedEntryCount: 0 });

  await emitStartReview({ tenantId: "T1", contentId: "C1", reviewId: "R1", contentVersion: "v1", platform: "blog" });

  const entry = sendMock.mock.calls[0][0].input.Entries[0];
  expect(entry.Source).toBe(REVIEW_EVENT_SOURCE);
  expect(entry.DetailType).toBe(START_REVIEW_DETAIL_TYPE);
  expect(JSON.parse(entry.Detail)).toEqual({
    tenantId: "T1", contentId: "C1", reviewId: "R1", contentVersion: "v1", platform: "blog",
  });
});

test("throws when the event fails to publish", async () => {
  sendMock.mockResolvedValue({ FailedEntryCount: 1, Entries: [{ ErrorMessage: "throttled" }] });
  await expect(
    emitStartReview({ tenantId: "T1", contentId: "C1", reviewId: "R1", contentVersion: "v1" }),
  ).rejects.toThrow("Failed to start review");
});
