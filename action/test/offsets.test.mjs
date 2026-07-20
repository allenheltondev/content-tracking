import test from 'node:test';
import assert from 'node:assert/strict';
import { offsetToLineCol, buildSuggestion, isInlineable, suggestionCommentBody } from '../src/offsets.mjs';
import { splitFrontMatter } from '../src/frontmatter.mjs';

test('offsetToLineCol maps offsets to 0-based line/col', () => {
  const t = 'ab\ncde\nf';
  assert.deepEqual(offsetToLineCol(t, 0), { line: 0, col: 0 });
  assert.deepEqual(offsetToLineCol(t, 4), { line: 1, col: 1 }); // 'd'
  assert.deepEqual(offsetToLineCol(t, 7), { line: 2, col: 0 }); // 'f'
});

test('buildSuggestion reconstructs a single line with the substring replaced, accounting for front matter', () => {
  const file = '---\ntitle: Hi\n---\nThe quick brown fox.\n';
  const { bodyOffset, body } = splitFrontMatter(file);
  const start = body.indexOf('quick');
  const res = buildSuggestion({ fileText: file, bodyOffset, startOffset: start, endOffset: start + 5, replaceWith: 'swift' });
  assert.equal(res.startLine, 4);
  assert.equal(res.endLine, 4);
  assert.equal(res.replacement, 'The swift brown fox.');
});

test('buildSuggestion collapses a multi-line span into the replacement', () => {
  const file = 'aaa\nbbb'; // no front matter
  // replace "a\nb" (spans the newline) with "X"
  const res = buildSuggestion({ fileText: file, bodyOffset: 0, startOffset: 2, endOffset: 5, replaceWith: 'X' });
  assert.equal(res.startLine, 1);
  assert.equal(res.endLine, 2);
  assert.equal(res.replacement, 'aaXbb');
});

test('isInlineable requires every spanned line to be commentable', () => {
  assert.equal(isInlineable(4, 4, new Set([4])), true);
  assert.equal(isInlineable(4, 5, new Set([4])), false);
  assert.equal(isInlineable(4, 5, new Set([4, 5])), true);
});

test('suggestionCommentBody wraps the replacement in a suggestion block', () => {
  const body = suggestionCommentBody('new line', 'run-on sentence', 'grammar');
  assert.match(body, /\*\*grammar\*\* — run-on sentence/);
  assert.match(body, /```suggestion\nnew line\n```/);
});
