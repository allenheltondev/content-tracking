import { createHash } from "node:crypto";

// Anchoring for AI review suggestions. A suggestion points at a span of the
// content body [startOffset, endOffset) that should become `replaceWith`. The
// model is not trusted to get the offsets right (it routinely miscounts), and
// even correct offsets drift the moment the author edits the body. So every
// suggestion is anchored two ways:
//
//   1. offsets  — where the span is *now* (re-derived from the text, never the
//      model's raw numbers).
//   2. context  — the exact substring (`anchorText`) plus a small window of
//      text on each side (`contextBefore` / `contextAfter`) and a hash of the
//      three. Offsets rot across edits; the context survives, so it's what we
//      use to decide whether a suggestion still applies after the body changes.
//
// Ported from content-agent's create-suggestions anchoring (findActualOffsets +
// contextHash), adapted to this stack's conventions. Pure + dependency-light so
// it unit-tests without DynamoDB or Bedrock.

// Characters of surrounding text captured on each side of the anchor. Enough to
// disambiguate a repeated phrase without bloating the row.
export const CONTEXT_WINDOW = 30;

// How far from the model-suggested offset we'll look for the real text before
// falling back to a whole-body search. Nova's offsets are usually close but not
// exact, so a tight local search resolves most cases cheaply and avoids
// latching onto a same-text occurrence elsewhere in the document.
export const OFFSET_TOLERANCE = 50;

// Stable short fingerprint of a suggestion's location, from the text on either
// side of the anchor plus the anchor itself. Two suggestions with the same
// fingerprint target the same place and are duplicates; the same fingerprint
// also lets us recognise a suggestion after the body around it is unchanged.
export function contextHash(contextBefore, anchorText, contextAfter) {
  return createHash("sha256")
    .update(`${contextBefore}|${anchorText}|${contextAfter}`)
    .digest("hex")
    .slice(0, 16);
}

// Re-derives the true [start, end) of `textToReplace` in `body`, trusting the
// text over the model's offsets. Strategy, cheapest first:
//   1. the suggested offsets already frame the text exactly — take them.
//   2. the text sits within OFFSET_TOLERANCE of the suggested start — take the
//      nearest such occurrence (handles small miscounts without jumping to a
//      duplicate far away).
//   3. the text occurs somewhere in the body — take the occurrence closest to
//      the suggested start.
// Returns { startOffset, endOffset } or null when the text isn't in the body
// (a stale or hallucinated span — the caller drops it).
export function findActualOffsets(body, { startOffset, endOffset, textToReplace }) {
  if (typeof body !== "string" || typeof textToReplace !== "string" || textToReplace.length === 0) {
    return null;
  }

  const hinted = Number.isInteger(startOffset) ? startOffset : -1;

  // 1. Exact framing.
  if (
    hinted >= 0 &&
    Number.isInteger(endOffset) &&
    body.slice(hinted, endOffset) === textToReplace
  ) {
    return { startOffset: hinted, endOffset };
  }

  // Collect every occurrence so we can pick the one nearest the model's hint.
  const occurrences = [];
  let from = 0;
  for (;;) {
    const idx = body.indexOf(textToReplace, from);
    if (idx === -1) break;
    occurrences.push(idx);
    from = idx + 1;
  }
  if (occurrences.length === 0) return null;

  // 2. Prefer an occurrence within tolerance of the hint.
  if (hinted >= 0) {
    const near = occurrences
      .filter((idx) => Math.abs(idx - hinted) <= OFFSET_TOLERANCE)
      .sort((a, b) => Math.abs(a - hinted) - Math.abs(b - hinted));
    if (near.length > 0) {
      return { startOffset: near[0], endOffset: near[0] + textToReplace.length };
    }
  }

  // 3. Closest occurrence overall (nearest the hint, or the first when no hint).
  const best = hinted >= 0
    ? occurrences.slice().sort((a, b) => Math.abs(a - hinted) - Math.abs(b - hinted))[0]
    : occurrences[0];
  return { startOffset: best, endOffset: best + textToReplace.length };
}

// Turns a raw model suggestion into a fully anchored record, or null when its
// text can't be located in the current body. The returned object carries both
// the re-derived offsets and the context anchor (+hash) used for cross-edit
// survival. `replaceWith` / `reason` / `type` / `priority` are passed through
// unchanged — this function owns location, not content.
export function anchorSuggestion(body, suggestion) {
  const offsets = findActualOffsets(body, suggestion);
  if (!offsets) return null;

  const { startOffset, endOffset } = offsets;
  const anchorText = body.slice(startOffset, endOffset);
  const contextBefore = body.slice(Math.max(0, startOffset - CONTEXT_WINDOW), startOffset);
  const contextAfter = body.slice(endOffset, endOffset + CONTEXT_WINDOW);

  return {
    startOffset,
    endOffset,
    anchorText,
    contextBefore,
    contextAfter,
    contextHash: contextHash(contextBefore, anchorText, contextAfter),
  };
}

// Decides whether an already-anchored suggestion still applies to a (possibly
// edited) body. The anchor text must still be present, and — when we captured
// surrounding context — the full context window must still appear intact, so a
// suggestion doesn't resurface pointing at an unrelated later occurrence of the
// same phrase. Trimmed to tolerate whitespace-only edits at the window edges.
export function isSuggestionAnchored(body, { anchorText, contextBefore = "", contextAfter = "" }) {
  if (typeof body !== "string" || typeof anchorText !== "string" || anchorText.length === 0) {
    return false;
  }
  if (!body.includes(anchorText)) return false;

  const hasContext = contextBefore.length > 0 || contextAfter.length > 0;
  if (!hasContext) return true;

  return body.includes(`${contextBefore}${anchorText}${contextAfter}`.trim());
}
