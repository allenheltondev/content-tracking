import { describe, expect, test } from 'vitest';
import type { Suggestion } from '../api/review';
import { applySuggestion, recalculateSuggestionOffsets, validateSuggestionOffsets } from './suggestionOffsets';

function sug(over: Partial<Suggestion> & { startOffset: number; endOffset: number; textToReplace: string }): Suggestion {
  return {
    id: over.id ?? 's',
    reviewId: null,
    type: 'grammar',
    priority: 'medium',
    reason: '',
    replaceWith: over.replaceWith ?? '',
    contextBefore: '',
    contextAfter: '',
    createdAt: '',
    ...over,
  };
}

const BODY = 'The quick brown fox jumps over the lazy dog.';

describe('recalculateSuggestionOffsets', () => {
  test('shifts suggestions after the edit by the length delta', () => {
    // replace "quick" (4..9) with "swift and nimble" (+11)
    const after = sug({ id: 'a', startOffset: BODY.indexOf('lazy'), endOffset: BODY.indexOf('lazy') + 4, textToReplace: 'lazy' });
    const [out] = recalculateSuggestionOffsets([after], 4, 9, 'swift and nimble');
    expect(out.startOffset).toBe(after.startOffset + 11);
    expect(out.endOffset).toBe(after.endOffset + 11);
  });

  test('drops a suggestion that overlaps the edited span', () => {
    const overlapping = sug({ startOffset: 4, endOffset: 9, textToReplace: 'quick' });
    expect(recalculateSuggestionOffsets([overlapping], 4, 9, 'swift')).toEqual([]);
  });

  test('leaves suggestions before the edit untouched', () => {
    const before = sug({ startOffset: 0, endOffset: 3, textToReplace: 'The' });
    const [out] = recalculateSuggestionOffsets([before], 10, 15, 'X');
    expect(out.startOffset).toBe(0);
    expect(out.endOffset).toBe(3);
  });
});

describe('validateSuggestionOffsets', () => {
  test('keeps a suggestion whose text still frames its offsets', () => {
    const s = sug({ startOffset: BODY.indexOf('brown'), endOffset: BODY.indexOf('brown') + 5, textToReplace: 'brown' });
    expect(validateSuggestionOffsets([s], BODY)).toEqual([s]);
  });

  test('self-heals a suggestion whose offsets drifted', () => {
    const real = BODY.indexOf('fox');
    const drifted = sug({ startOffset: real + 5, endOffset: real + 8, textToReplace: 'fox' });
    const [out] = validateSuggestionOffsets([drifted], BODY);
    expect(out.startOffset).toBe(real);
    expect(out.endOffset).toBe(real + 3);
  });

  test('relocates via global search when the offsets are far off', () => {
    const s = sug({ startOffset: 999, endOffset: 1002, textToReplace: 'dog' });
    const [out] = validateSuggestionOffsets([s], BODY);
    expect(out.startOffset).toBe(BODY.indexOf('dog'));
  });

  test('drops a suggestion whose text is gone', () => {
    const s = sug({ startOffset: 0, endOffset: 5, textToReplace: 'zebra' });
    expect(validateSuggestionOffsets([s], BODY)).toEqual([]);
  });
});

describe('applySuggestion', () => {
  test('applies the replacement and recomputes the remaining offsets', () => {
    const toApply = sug({ id: 'x', startOffset: BODY.indexOf('quick'), endOffset: BODY.indexOf('quick') + 5, textToReplace: 'quick', replaceWith: 'swift' });
    const other = sug({ id: 'y', startOffset: BODY.indexOf('lazy'), endOffset: BODY.indexOf('lazy') + 4, textToReplace: 'lazy' });

    const { newContent, updatedSuggestions } = applySuggestion(BODY, toApply, [other]);

    expect(newContent).toBe(BODY.replace('quick', 'swift'));
    // "quick"->"swift" is same length, so "lazy" stays put and still validates.
    expect(updatedSuggestions).toHaveLength(1);
    expect(newContent.substring(updatedSuggestions[0].startOffset, updatedSuggestions[0].endOffset)).toBe('lazy');
  });

  test('a shorter replacement shifts and still resolves later suggestions', () => {
    const toApply = sug({ id: 'x', startOffset: BODY.indexOf('quick'), endOffset: BODY.indexOf('quick') + 5, textToReplace: 'quick', replaceWith: 'fast' });
    const other = sug({ id: 'y', startOffset: BODY.indexOf('dog'), endOffset: BODY.indexOf('dog') + 3, textToReplace: 'dog' });

    const { newContent, updatedSuggestions } = applySuggestion(BODY, toApply, [other]);
    expect(newContent).toBe(BODY.replace('quick', 'fast'));
    expect(newContent.substring(updatedSuggestions[0].startOffset, updatedSuggestions[0].endOffset)).toBe('dog');
  });
});
