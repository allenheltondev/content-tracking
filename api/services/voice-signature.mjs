// Deterministic style-marker analysis over a creator's published voice samples.
//
// The learned Voice profile is a model's prose description of how someone
// writes. That is the right input for "does this sound like them?", but it is a
// weak input for "do not flag this": a lens told "they write conversationally"
// will still cheerfully strip every em dash. This module measures the concrete,
// countable habits instead — em dashes, rhetorical questions, direct address,
// one-line paragraphs — so the voice-blind lenses can be handed a factual list
// of traits that are established rather than accidental.
//
// A marker becomes a "signature habit" only when it clears BOTH bars:
//   - prevalence: it appears in most of their posts, so it is a habit and not
//     one post's quirk;
//   - rate: it appears often enough to be a trait at all.
// That pairing is what makes the output safe to hand a model as "never flag
// this on its own".

// Below this many samples there isn't enough corpus to call anything a habit,
// so the whole analysis reports nothing rather than over-claiming from one post.
const MIN_SAMPLES = 3;

// A marker has to show up in at least this share of the posts to count.
const MIN_PREVALENCE = 0.6;

// Rates are normalized per 1000 words so a marker's bar means the same thing
// whether the corpus is five 500-word posts or five 3000-word ones.
const RATE_UNIT = 1000;

// The markers. `match` returns the number of occurrences in one (noise-stripped)
// sample; `minRate` is the per-1000-word bar the whole corpus must clear.
// Thresholds are deliberately generous: the cost of missing a real habit (a lens
// flattens it) is higher than the cost of protecting a mild one (a lens leaves
// a few instances alone).
const MARKERS = [
  {
    key: "emDash",
    label: "Em dashes and parenthetical dashes",
    minRate: 2,
    match: (text) => count(text, /—|(?:^|\s)--(?:\s|$)/g),
  },
  {
    key: "secondPerson",
    label: "Direct address to the reader (\"you\", \"your\")",
    minRate: 8,
    match: (text) => count(text, /\byou(?:r|rs|'re|'ve|'ll|'d)?\b/gi),
  },
  {
    key: "firstPerson",
    label: "First-person voice (\"I\", \"my\", \"me\")",
    minRate: 5,
    match: (text) => count(text, /\bI(?:'m|'ve|'ll|'d)?\b|\bmy\b|\bme\b/g),
  },
  {
    key: "contractions",
    label: "Contractions (\"don't\", \"it's\", \"you'll\")",
    minRate: 10,
    match: (text) => count(text, /\b\w+['’](?:s|t|re|ve|ll|d|m)\b/gi),
  },
  {
    key: "questions",
    label: "Rhetorical questions",
    minRate: 1.5,
    match: (text) => count(text, /\?/g),
  },
  {
    key: "exclamations",
    label: "Exclamations",
    minRate: 1,
    match: (text) => count(text, /!/g),
  },
  {
    key: "parentheticals",
    label: "Parenthetical asides",
    minRate: 2,
    match: (text) => count(text, /\([^)]{3,}\)/g),
  },
  {
    key: "ellipses",
    label: "Trailing ellipses",
    minRate: 1,
    match: (text) => count(text, /\.\.\.|…/g),
  },
  {
    key: "shortParagraphs",
    label: "One-line paragraphs used for emphasis",
    minRate: 3,
    match: (text) => paragraphs(text).filter(isPunchyParagraph).length,
  },
];

function count(text, re) {
  return (text.match(re) ?? []).length;
}

// Markdown noise skews every marker: fenced code is full of punctuation the
// author never "wrote", link targets inflate word counts, and heading markers
// fragment sentences. Strip them before measuring, keeping the prose (including
// link text, which is prose the author did write).
export function stripMarkdownNoise(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^ {4,}\S.*$/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/https?:\/\/\S+/g, " ");
}

function words(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function paragraphs(text) {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

function sentences(text) {
  return text.split(/[.!?]+(?=\s|$)/).map((s) => s.trim()).filter(Boolean);
}

// A paragraph that is one short sentence standing alone. The rhythm trick a
// readability lens reliably wants to merge back into the paragraph above it.
function isPunchyParagraph(paragraph) {
  return sentences(paragraph).length === 1 && words(paragraph) <= 12;
}

// Measures ONE piece of writing. Returns the per-post counts a signature is
// built from, or null when the text carries no prose.
//
// This is split out from the aggregate on purpose: every quantity here is
// additive across posts, so a corpus can be measured once per post, at the
// moment the post is captured and its full body is in hand, and aggregated
// later from the stored counts. That is what lets the signature describe whole
// published posts without any consumer ever re-reading them.
export function measureText(text) {
  const prose = stripMarkdownNoise(text);
  const wordCount = words(prose);
  if (wordCount === 0) return null;

  const sentenceList = sentences(prose);
  const markers = {};
  for (const marker of MARKERS) {
    markers[marker.key] = marker.match(prose);
  }

  return {
    words: wordCount,
    sentences: sentenceList.length,
    sentenceWords: sentenceList.reduce((acc, sentence) => acc + words(sentence), 0),
    markers,
  };
}

// Folds per-post measurements into the signature: the habits that clear both
// bars, plus the stats the prompts quote. Returns null when there isn't enough
// corpus to say anything, so callers can treat "no signature" as a first-class
// state instead of rendering an empty section.
export function aggregateSignature(measurements, { minSamples = MIN_SAMPLES } = {}) {
  const list = (measurements ?? []).filter((m) => m && m.words > 0);
  if (list.length < minSamples) return null;

  const totalWords = list.reduce((acc, m) => acc + m.words, 0);
  if (totalWords === 0) return null;

  const habits = [];
  for (const marker of MARKERS) {
    const occurrences = list.reduce((acc, m) => acc + (m.markers?.[marker.key] ?? 0), 0);
    const postsWith = list.filter((m) => (m.markers?.[marker.key] ?? 0) > 0).length;
    const prevalence = postsWith / list.length;
    const rate = (occurrences / totalWords) * RATE_UNIT;

    if (prevalence >= MIN_PREVALENCE && rate >= marker.minRate) {
      habits.push({
        key: marker.key,
        label: marker.label,
        rate: round(rate, 1),
        prevalence: round(prevalence, 2),
        postsWith,
        occurrences,
      });
    }
  }

  const totalSentences = list.reduce((acc, m) => acc + (m.sentences ?? 0), 0);
  const totalSentenceWords = list.reduce((acc, m) => acc + (m.sentenceWords ?? 0), 0);

  return {
    sampleCount: list.length,
    wordCount: totalWords,
    avgSentenceWords: totalSentences > 0 ? round(totalSentenceWords / totalSentences, 0) : 0,
    habits: habits.sort((a, b) => b.rate - a.rate),
  };
}

// Measures a set of texts and folds them in one step. The path for callers that
// hold text and nothing else — the review's fallback, where samples come back
// from the vector index carrying no stored measurements.
export function analyzeVoiceSignature(samples, options = {}) {
  return aggregateSignature((samples ?? []).map((s) => measureText(s?.text)), options);
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// Renders the signature into the prompt block the style lenses reason against.
// Returns "" when there is nothing measured, so callers can concatenate it
// unconditionally. The framing matters as much as the numbers: these are stated
// as facts about published writing and paired with an explicit instruction, so
// a lens can't read the list as a set of defects to go fix.
export function renderSignatureHabits(signature) {
  if (!signature || signature.habits.length === 0) return "";

  const lines = signature.habits.map(
    (h) => `- ${h.label}: about ${h.rate} per 1000 words, present in ${h.postsWith} of ${signature.sampleCount} posts.`,
  );
  lines.push(`- Their sentences average ${signature.avgSentenceWords} words.`);

  return `=== MEASURED HABITS OF THEIR PUBLISHED WRITING (${signature.sampleCount} posts, ${signature.wordCount} words) ===
These traits were counted in writing this author already published. They are the
author's style, not defects, and not signs of machine-generated text:
${lines.join("\n")}

Treat every trait above as deliberate. Do NOT suggest an edit whose reason is
that one of these traits is overused, informal, or unconventional. Flag an
individual instance only when it is clearly worse than how this author normally
uses it, and say so in the reason.`;
}
