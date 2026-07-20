import test from 'node:test';
import assert from 'node:assert/strict';
import { commentableLines } from '../src/diff.mjs';

test('collects added + context line numbers on the new side', () => {
  const patch = [
    '@@ -1,2 +1,3 @@',
    ' context line 1', // new line 1 (context)
    '+added line 2', //   new line 2 (added)
    ' context line 3', // new line 3 (context)
  ].join('\n');
  const lines = commentableLines(patch);
  assert.deepEqual([...lines].sort((a, b) => a - b), [1, 2, 3]);
});

test('deleted lines do not advance the new-side counter', () => {
  const patch = [
    '@@ -1,3 +1,2 @@',
    ' keep', //     new line 1
    '-removed', //  left side only
    '+replaced', // new line 2
  ].join('\n');
  const lines = commentableLines(patch);
  assert.deepEqual([...lines].sort((a, b) => a - b), [1, 2]);
});

test('handles multiple hunks and a starting offset', () => {
  const patch = ['@@ -10,1 +20,2 @@', ' a', '+b'].join('\n');
  const lines = commentableLines(patch);
  assert.deepEqual([...lines].sort((a, b) => a - b), [20, 21]);
});

test('empty or missing patch yields an empty set', () => {
  assert.equal(commentableLines(undefined).size, 0);
  assert.equal(commentableLines('').size, 0);
});
