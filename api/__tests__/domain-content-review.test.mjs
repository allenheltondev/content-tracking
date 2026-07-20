import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const {
  recordSuggestions,
  listSuggestions,
  updateSuggestionStatus,
  revalidateSuggestions,
  createReview,
  claimReview,
} = await import("../domain/content-review.mjs");

const TENANT = "user-1";
const CONTENT_ID = "01HCONTENT";
const BODY = "The quick brown fox jumps over the lazy dog. The fox runs fast.";

describe("domain/content-review", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  describe("createReview", () => {
    test("writes a pending review stamped with the content version", async () => {
      mockSend.mockResolvedValue({});
      const review = await createReview(TENANT, CONTENT_ID, { contentVersion: "2026-07-18T00:00:00Z" });

      expect(review.entity).toBe("ContentReview");
      expect(review.status).toBe("pending");
      expect(review.contentVersion).toBe("2026-07-18T00:00:00Z");
      expect(review.sk).toBe(`CONTENT#${CONTENT_ID}#REVIEW#${review.reviewId}`);
      const put = mockSend.mock.calls[0][0].input;
      expect(put.ConditionExpression).toBe("attribute_not_exists(sk)");
    });
  });

  describe("claimReview", () => {
    test("claims a pending review (pending -> running) and returns true", async () => {
      mockSend.mockResolvedValue({});
      const ok = await claimReview(TENANT, CONTENT_ID, "R1");
      expect(ok).toBe(true);
      const input = mockSend.mock.calls[0][0].input;
      expect(input.ExpressionAttributeValues[":running"]).toBe("running");
      expect(input.ConditionExpression).toContain("#status = :pending");
    });

    test("returns false when the review is already claimed/completed", async () => {
      mockSend.mockRejectedValue(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));
      expect(await claimReview(TENANT, CONTENT_ID, "R1")).toBe(false);
    });
  });

  describe("recordSuggestions", () => {
    test("anchors each suggestion, drops unfindable text, and collapses duplicates", async () => {
      mockSend.mockResolvedValue({});
      const items = await recordSuggestions(TENANT, CONTENT_ID, {
        reviewId: "rev-1",
        contentVersion: "v1",
        body: BODY,
        suggestions: [
          { type: "grammar", priority: "high", reason: "x", textToReplace: "quick", replaceWith: "swift" },
          // duplicate of the first location (same anchor + context) — dropped
          { type: "llm", priority: "low", reason: "y", textToReplace: "quick", replaceWith: "fast" },
          // not present in the body — dropped
          { type: "fact", reason: "z", textToReplace: "unicorn", replaceWith: "" },
          { type: "brand", priority: "medium", reason: "w", textToReplace: "lazy", replaceWith: "sleepy" },
        ],
      });

      expect(items).toHaveLength(2);
      expect(items.map((i) => i.anchorText).sort()).toEqual(["lazy", "quick"]);
      for (const it of items) {
        expect(it.entity).toBe("ContentSuggestion");
        expect(it.status).toBe("pending");
        expect(it.reviewId).toBe("rev-1");
        expect(it.startOffset).toBe(BODY.indexOf(it.anchorText));
        expect(typeof it.contextHash).toBe("string");
      }

      const batch = mockSend.mock.calls[0][0].input;
      expect(batch.RequestItems["test-booked"]).toHaveLength(2);
    });

    test("returns [] and writes nothing when no suggestion anchors", async () => {
      mockSend.mockResolvedValue({});
      const items = await recordSuggestions(TENANT, CONTENT_ID, {
        body: BODY,
        suggestions: [{ type: "grammar", textToReplace: "does-not-exist", replaceWith: "y" }],
      });
      expect(items).toEqual([]);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("listSuggestions", () => {
    test("queries the suggestion prefix filtered to pending by default", async () => {
      mockSend.mockResolvedValue({ Items: [{ suggestionId: "a", status: "pending" }] });
      const items = await listSuggestions(TENANT, CONTENT_ID);

      const input = mockSend.mock.calls[0][0].input;
      expect(input.KeyConditionExpression).toContain("begins_with(sk, :prefix)");
      expect(input.ExpressionAttributeValues[":prefix"]).toBe(`CONTENT#${CONTENT_ID}#SUGGESTION#`);
      expect(input.ExpressionAttributeValues[":status"]).toBe("pending");
      expect(items).toHaveLength(1);
    });
  });

  describe("updateSuggestionStatus", () => {
    test("sets the status and returns the updated row", async () => {
      mockSend.mockResolvedValue({ Attributes: { suggestionId: "a", status: "accepted" } });
      const updated = await updateSuggestionStatus(TENANT, CONTENT_ID, "a", "accepted");
      expect(updated.status).toBe("accepted");
      const input = mockSend.mock.calls[0][0].input;
      expect(input.ExpressionAttributeValues[":status"]).toBe("accepted");
      expect(input.ConditionExpression).toBe("attribute_exists(sk)");
    });

    test("maps a missing suggestion to NotFoundError", async () => {
      mockSend.mockRejectedValue(Object.assign(new Error("nope"), { name: "ConditionalCheckFailedException" }));
      await expect(updateSuggestionStatus(TENANT, CONTENT_ID, "missing", "rejected")).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  describe("revalidateSuggestions", () => {
    test("keeps still-anchored suggestions and skips ones the edit removed", async () => {
      const pending = [
        {
          suggestionId: "keep",
          status: "pending",
          anchorText: "brown",
          contextBefore: "quick ",
          contextAfter: " fox",
          contentVersion: "v1",
        },
        {
          suggestionId: "gone",
          status: "pending",
          anchorText: "lazy",
          contextBefore: "the ",
          contextAfter: " dog",
          contentVersion: "v1",
        },
      ];
      // First call = listSuggestions Query; subsequent = per-row Updates.
      mockSend.mockImplementation((cmd) => {
        if (cmd.input.KeyConditionExpression) return Promise.resolve({ Items: pending });
        return Promise.resolve({});
      });

      // Insert text before the spans so a kept suggestion's offsets must move,
      // and remove "lazy" so that suggestion is skipped.
      const edited = `PREFIX. ${BODY}`.replace("lazy", "energetic");
      const res = await revalidateSuggestions(TENANT, CONTENT_ID, edited, { contentVersion: "v2" });

      expect(res).toEqual({ kept: 1, skipped: 1 });

      const updates = mockSend.mock.calls.filter((c) => c[0].input.UpdateExpression);
      const keepUpdate = updates.find((c) => c[0].input.Key.sk.endsWith("#keep"));
      const goneUpdate = updates.find((c) => c[0].input.Key.sk.endsWith("#gone"));
      // kept: version re-stamped AND offsets re-located to the new position
      expect(keepUpdate[0].input.ExpressionAttributeValues[":v"]).toBe("v2");
      expect(keepUpdate[0].input.ExpressionAttributeValues[":start"]).toBe(edited.indexOf("brown"));
      expect(keepUpdate[0].input.ExpressionAttributeValues[":end"]).toBe(edited.indexOf("brown") + "brown".length);
      expect(goneUpdate[0].input.ExpressionAttributeValues[":skipped"]).toBe("skipped");
      expect(goneUpdate[0].input.ConditionExpression).toContain("#status = :pending");
    });
  });
});
