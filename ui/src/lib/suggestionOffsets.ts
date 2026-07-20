import type { Suggestion } from '../api/review';

// Client-side offset maintenance for review suggestions. When the author accepts
// a suggestion (or edits the body), every other suggestion's [startOffset,
// endOffset) has to shift to stay pointed at the right span, and any suggestion
// whose text the edit removed has to drop. The server re-anchors on its own copy
// (the revalidation stream consumer), but the editor needs to do it live and
// locally so highlights and applied edits stay correct between saves.
//
// Ported from content-agent's suggestionOffsetCalculation, adapted to this app's
// Suggestion shape and de-noised (no console logging).

// Shifts remaining suggestions' offsets after a span [changeStart, changeEnd)
// was replaced with `replacementText`. Suggestions overlapping the edited span
// are dropped (null-filtered); ones after the edit shift by the length delta;
// ones before are untouched.
export function recalculateSuggestionOffsets(
  suggestions: Suggestion[],
  changeStartOffset: number,
  changeEndOffset: number,
  replacementText: string,
): Suggestion[] {
  const offsetDelta = replacementText.length - (changeEndOffset - changeStartOffset);

  return suggestions
    .map((s): Suggestion | null => {
      const overlaps = !(s.endOffset <= changeStartOffset || s.startOffset >= changeEndOffset);
      if (overlaps) return null;
      if (s.startOffset >= changeEndOffset) {
        return { ...s, startOffset: s.startOffset + offsetDelta, endOffset: s.endOffset + offsetDelta };
      }
      return s;
    })
    .filter((s): s is Suggestion => s !== null);
}

// Verifies each suggestion still frames its `textToReplace` in `content`, and
// self-heals the ones that drifted by re-locating the text (nearby first, then a
// series of fuzzier strategies). Suggestions whose text can't be found are
// dropped.
export function validateSuggestionOffsets(suggestions: Suggestion[], content: string): Suggestion[] {
  return suggestions
    .map((s): Suggestion | null => {
      if (s.startOffset < 0 || s.endOffset > content.length || s.startOffset >= s.endOffset) {
        return relocate(s, content);
      }
      const actual = content.substring(s.startOffset, s.endOffset);
      if (actual === s.textToReplace) return s;

      // Small local search first — cheap and avoids latching onto a duplicate
      // elsewhere in the document.
      const range = 50;
      const start = Math.max(0, s.startOffset - range);
      const end = Math.min(content.length, s.endOffset + range);
      const idx = content.substring(start, end).indexOf(s.textToReplace);
      if (idx !== -1) {
        const newStart = start + idx;
        return { ...s, startOffset: newStart, endOffset: newStart + s.textToReplace.length };
      }
      return relocate(s, content);
    })
    .filter((s): s is Suggestion => s !== null);
}

// Applies a suggestion to the content and returns the new content plus the
// remaining suggestions with their offsets recalculated and revalidated.
export function applySuggestion(
  content: string,
  toApply: Suggestion,
  remaining: Suggestion[],
): { newContent: string; updatedSuggestions: Suggestion[] } {
  const newContent =
    content.substring(0, toApply.startOffset) + toApply.replaceWith + content.substring(toApply.endOffset);

  const shifted = recalculateSuggestionOffsets(remaining, toApply.startOffset, toApply.endOffset, toApply.replaceWith);
  return { newContent, updatedSuggestions: validateSuggestionOffsets(shifted, newContent) };
}

// Fuzzier re-location strategies, tried in order, for a suggestion whose text no
// longer sits at its offsets: expanded-range, case-insensitive, whitespace-
// normalized, keyword (first/last word) match for longer spans, and finally a
// global search. Returns the suggestion with corrected offsets, or null when the
// text is truly gone.
function relocate(s: Suggestion, content: string): Suggestion | null {
  const { textToReplace, startOffset, endOffset } = s;

  const range = Math.min(300, content.length / 3);
  const start = Math.max(0, startOffset - range);
  const end = Math.min(content.length, endOffset + range);
  const search = content.substring(start, end);

  // Expanded-range exact.
  let idx = search.indexOf(textToReplace);
  if (idx !== -1) {
    const ns = start + idx;
    return { ...s, startOffset: ns, endOffset: ns + textToReplace.length };
  }

  // Case-insensitive.
  idx = search.toLowerCase().indexOf(textToReplace.toLowerCase());
  if (idx !== -1) {
    const ns = start + idx;
    return { ...s, startOffset: ns, endOffset: ns + textToReplace.length };
  }

  // Whitespace-normalized.
  const normTarget = textToReplace.replace(/\s+/g, ' ').trim();
  const normSearch = search.replace(/\s+/g, ' ');
  idx = normSearch.indexOf(normTarget);
  if (idx !== -1) {
    let actualIndex = 0;
    let normalizedIndex = 0;
    while (normalizedIndex < idx && actualIndex < search.length) {
      if (/\s/.test(search[actualIndex])) {
        while (actualIndex < search.length && /\s/.test(search[actualIndex])) actualIndex++;
        normalizedIndex++;
      } else {
        actualIndex++;
        normalizedIndex++;
      }
    }
    const ns = start + actualIndex;
    return { ...s, startOffset: ns, endOffset: ns + textToReplace.length };
  }

  // Keyword match (first + last significant word) for longer spans.
  if (textToReplace.length > 10) {
    const words = textToReplace.split(/\s+/).filter((w) => w.length > 3);
    if (words.length >= 2) {
      const firstWord = words[0];
      const lastWord = words[words.length - 1];
      let searchIndex = 0;
      while (searchIndex < search.length) {
        const firstIdx = search.indexOf(firstWord, searchIndex);
        if (firstIdx === -1) break;
        const lastIdx = search.indexOf(lastWord, firstIdx + firstWord.length);
        if (lastIdx !== -1) {
          const cStart = start + firstIdx;
          const cEnd = start + lastIdx + lastWord.length;
          const candidate = content.substring(cStart, cEnd);
          if (Math.abs(candidate.length - textToReplace.length) <= textToReplace.length * 0.4) {
            return { ...s, startOffset: cStart, endOffset: cEnd, textToReplace: candidate };
          }
        }
        searchIndex = firstIdx + 1;
      }
    }
  }

  // Global search, last resort.
  idx = content.indexOf(textToReplace);
  if (idx !== -1) {
    return { ...s, startOffset: idx, endOffset: idx + textToReplace.length };
  }

  return null;
}
