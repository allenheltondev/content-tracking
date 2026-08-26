import { analyzeVoiceSignature, renderSignatureHabits, stripMarkdownNoise } from "../services/voice-signature.mjs";

// Neutral prose to pad a sample out to a given length without tripping any of
// the markers under test.
const filler = (words) => Array.from({ length: words }, () => "alpha").join(" ");

const posts = (texts) => texts.map((text) => ({ text }));

describe("analyzeVoiceSignature", () => {
  test("says nothing when the corpus is too small to call anything a habit", () => {
    expect(analyzeVoiceSignature(posts(["You know — I do.", "You know — I do."]))).toBeNull();
    expect(analyzeVoiceSignature([])).toBeNull();
    expect(analyzeVoiceSignature(null)).toBeNull();
  });

  test("ignores samples that are empty once markdown noise is stripped", () => {
    expect(analyzeVoiceSignature(posts(["```js\nconst a = 1 — 2;\n```", "`x — y`", "   "]))).toBeNull();
  });

  test("reports a marker that is both frequent and widespread", () => {
    const signature = analyzeVoiceSignature(
      posts(Array.from({ length: 5 }, () => `${filler(40)} — and here is the point — ${filler(40)}`)),
    );

    const emDash = signature.habits.find((h) => h.key === "emDash");
    expect(emDash).toMatchObject({ postsWith: 5, occurrences: 10 });
    expect(emDash.rate).toBeGreaterThan(2);
    expect(signature.sampleCount).toBe(5);
  });

  test("does not call one post's quirk a habit", () => {
    const heavy = `${filler(20)} — — — — — — — — — — ${filler(20)}`;
    const signature = analyzeVoiceSignature(posts([heavy, filler(60), filler(60), filler(60), filler(60)]));

    expect(signature.habits.find((h) => h.key === "emDash")).toBeUndefined();
  });

  test("does not call a rare marker a habit even when every post has one", () => {
    // One dash per 600-word post clears the prevalence bar but not the rate bar.
    const signature = analyzeVoiceSignature(posts(Array.from({ length: 5 }, () => `${filler(300)} — ${filler(300)}`)));

    expect(signature.habits.find((h) => h.key === "emDash")).toBeUndefined();
  });

  test("measures prose, not code samples", () => {
    const withCode = posts(Array.from({ length: 4 }, () => [
      "Here is how it works.",
      "```js",
      "// you — your — you're — you'll — do you? — really!",
      "const x = fn(a, b);",
      "```",
      `${filler(50)}`,
    ].join("\n")));

    const signature = analyzeVoiceSignature(withCode);
    expect(signature.habits.find((h) => h.key === "emDash")).toBeUndefined();
    expect(signature.habits.find((h) => h.key === "secondPerson")).toBeUndefined();
  });

  test("reports the author's average sentence length", () => {
    const signature = analyzeVoiceSignature(posts(Array.from({ length: 4 }, () => "One two three four five. Six seven eight nine ten.")));
    expect(signature.avgSentenceWords).toBe(5);
  });

  test("catches the traits a generic editor flattens", () => {
    const signature = analyzeVoiceSignature(
      posts(Array.from({ length: 4 }, (_, i) => [
        `Why does this matter? Because you'll hit it — probably today.`,
        ``,
        `Trust me.`,
        ``,
        `I've shipped it ${i} times (it still surprises me) and you won't love it.`,
      ].join("\n"))),
    );

    const keys = signature.habits.map((h) => h.key);
    expect(keys).toEqual(expect.arrayContaining(["emDash", "secondPerson", "firstPerson", "contractions", "questions", "parentheticals", "shortParagraphs"]));
  });
});

describe("stripMarkdownNoise", () => {
  test("drops code and link targets but keeps link text", () => {
    const out = stripMarkdownNoise("See [the docs](https://example.com/a—b) and `inline — code`.\n\n```\nfenced — code\n```");
    expect(out).toContain("the docs");
    expect(out).not.toContain("example.com");
    expect(out).not.toContain("inline");
    expect(out).not.toContain("fenced");
  });
});

describe("renderSignatureHabits", () => {
  test("renders the habits as facts with an explicit hands-off instruction", () => {
    const signature = analyzeVoiceSignature(
      posts(Array.from({ length: 5 }, () => `${filler(40)} — and here is the point — ${filler(40)}`)),
    );
    const block = renderSignatureHabits(signature);

    expect(block).toContain("MEASURED HABITS OF THEIR PUBLISHED WRITING (5 posts");
    expect(block).toContain("present in 5 of 5 posts");
    expect(block).toContain("not signs of machine-generated text");
    expect(block).toContain("Treat every trait above as deliberate");
  });

  test("renders nothing when there is nothing measured", () => {
    expect(renderSignatureHabits(null)).toBe("");
    expect(renderSignatureHabits({ sampleCount: 4, wordCount: 100, avgSentenceWords: 9, habits: [] })).toBe("");
  });
});
