import {
  anchorSuggestion,
  contextHash,
  findActualOffsets,
  isSuggestionAnchored,
  reanchorSuggestion,
} from "../services/suggestion-offsets.mjs";

const BODY = "The quick brown fox jumps over the lazy dog. The fox runs fast.";

describe("findActualOffsets", () => {
  test("takes the model offsets when they frame the text exactly", () => {
    const start = BODY.indexOf("brown");
    const res = findActualOffsets(BODY, {
      startOffset: start,
      endOffset: start + "brown".length,
      textToReplace: "brown",
    });
    expect(res).toEqual({ startOffset: start, endOffset: start + 5 });
  });

  test("recovers from an off-by-some hint within tolerance", () => {
    const actual = BODY.indexOf("jumps");
    const res = findActualOffsets(BODY, {
      startOffset: actual + 7, // model miscounted, but within OFFSET_TOLERANCE
      endOffset: actual + 12,
      textToReplace: "jumps",
    });
    expect(res).toEqual({ startOffset: actual, endOffset: actual + 5 });
  });

  test("picks the occurrence nearest the hint when the text repeats", () => {
    const second = BODY.indexOf("fox", BODY.indexOf("fox") + 1);
    const res = findActualOffsets(BODY, {
      startOffset: second - 2,
      endOffset: second + 1,
      textToReplace: "fox",
    });
    expect(res.startOffset).toBe(second);
  });

  test("clamps an overshooting endOffset hint to the matched length", () => {
    // slice() clamps a too-large endOffset, so the framed text still matches;
    // the returned endOffset must be the real end, not the out-of-range hint.
    expect(findActualOffsets("abc", { startOffset: 1, endOffset: 999, textToReplace: "bc" }))
      .toEqual({ startOffset: 1, endOffset: 3 });
  });

  test("returns null when the text is not in the body", () => {
    expect(findActualOffsets(BODY, { startOffset: 0, endOffset: 3, textToReplace: "zebra" })).toBeNull();
  });

  test("returns null for empty or non-string inputs", () => {
    expect(findActualOffsets(BODY, { startOffset: 0, endOffset: 0, textToReplace: "" })).toBeNull();
    expect(findActualOffsets(null, { startOffset: 0, endOffset: 1, textToReplace: "x" })).toBeNull();
  });
});

describe("anchorSuggestion", () => {
  test("captures re-derived offsets plus a context window and hash", () => {
    const anchor = anchorSuggestion(BODY, {
      startOffset: 999, // deliberately wrong — must be corrected
      endOffset: 1002,
      textToReplace: "lazy",
    });
    const start = BODY.indexOf("lazy");
    expect(anchor.startOffset).toBe(start);
    expect(anchor.endOffset).toBe(start + 4);
    expect(anchor.anchorText).toBe("lazy");
    expect(anchor.contextBefore.endsWith("the ")).toBe(true);
    expect(anchor.contextAfter.startsWith(" dog")).toBe(true);
    expect(anchor.contextHash).toBe(
      contextHash(anchor.contextBefore, anchor.anchorText, anchor.contextAfter),
    );
  });

  test("returns null when the span text is absent", () => {
    expect(anchorSuggestion(BODY, { startOffset: 0, endOffset: 5, textToReplace: "unicorn" })).toBeNull();
  });

  test("same span yields a stable contextHash across calls", () => {
    const a = anchorSuggestion(BODY, { startOffset: -1, endOffset: -1, textToReplace: "quick" });
    const b = anchorSuggestion(BODY, { startOffset: -1, endOffset: -1, textToReplace: "quick" });
    expect(a.contextHash).toBe(b.contextHash);
  });
});

describe("reanchorSuggestion", () => {
  const stored = anchorSuggestion(BODY, { startOffset: -1, endOffset: -1, textToReplace: "brown" });

  test("recomputes offsets after an edit shifts the span", () => {
    const edited = `PREFIX INSERTED. ${BODY}`; // pushes every offset right
    const a = reanchorSuggestion(edited, stored);
    expect(a.startOffset).toBe(edited.indexOf("brown"));
    expect(a.endOffset).toBe(edited.indexOf("brown") + "brown".length);
    expect(a.anchorText).toBe("brown");
    // the fresh hash reflects the (unchanged) surrounding context
    expect(a.contextHash).toBe(contextHash(a.contextBefore, a.anchorText, a.contextAfter));
  });

  test("pins the correct occurrence via context when the anchor repeats", () => {
    const s = anchorSuggestion(BODY, {
      startOffset: BODY.indexOf("fox", 20),
      endOffset: BODY.indexOf("fox", 20) + 3,
      textToReplace: "fox",
    });
    const edited = `INTRO. ${BODY}`;
    const a = reanchorSuggestion(edited, s);
    // second "fox", not the first, located by its distinct surrounding context
    expect(a.startOffset).toBe(edited.indexOf("fox", edited.indexOf("fox") + 1));
  });

  test("returns null when the anchor text is gone", () => {
    expect(reanchorSuggestion("nothing relevant here", stored)).toBeNull();
  });
});

describe("isSuggestionAnchored", () => {
  const anchor = anchorSuggestion(BODY, { startOffset: -1, endOffset: -1, textToReplace: "brown" });

  test("true when anchor + context still appear intact", () => {
    expect(isSuggestionAnchored(BODY, anchor)).toBe(true);
  });

  test("true after an unrelated edit elsewhere keeps the context intact", () => {
    const edited = BODY.replace("runs fast", "sprints");
    expect(isSuggestionAnchored(edited, anchor)).toBe(true);
  });

  test("false when the edit removes the anchored text", () => {
    const edited = BODY.replace("brown", "red");
    expect(isSuggestionAnchored(edited, anchor)).toBe(false);
  });

  test("false when the surrounding context was rewritten even if the word survives", () => {
    const edited = BODY.replace("quick brown fox", "brown");
    expect(isSuggestionAnchored(edited, anchor)).toBe(false);
  });

  test("anchor-only (no context) survives on presence alone", () => {
    expect(isSuggestionAnchored(BODY, { anchorText: "dog" })).toBe(true);
    expect(isSuggestionAnchored("no animals here", { anchorText: "dog" })).toBe(false);
  });
});
