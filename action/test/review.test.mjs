import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewPost, buildComments, renderSummary, SUMMARY_MARKER } from '../src/review.mjs';

function fakeClient(overrides = {}) {
  const calls = [];
  const base = {
    findBySlug: async () => null,
    createContent: async (f) => { calls.push(['create', f]); return { content_id: 'C1' }; },
    updateContent: async (id, f) => { calls.push(['update', id, f]); return { content_id: id }; },
    startReview: async (id, platform) => { calls.push(['startReview', id, platform]); return { id: 'R1', status: 'pending' }; },
    getReview: async (_id, rid) => ({ id: rid, status: 'succeeded' }),
    getSuggestions: async () => ({ suggestions: [{ id: 's1', review_id: 'R1' }], review: { id: 'R1', status: 'succeeded', summary: 'ok' } }),
  };
  return { client: { ...base, ...overrides }, calls };
}

test('reviewPost creates a new post when the slug is unknown, then polls to done', async () => {
  const { client, calls } = fakeClient();
  const res = await reviewPost(client, { slug: 'x', title: 'X', body: 'b' }, { sleep: async () => {}, attempts: 5 });
  assert.equal(calls[0][0], 'create');
  assert.equal(res.contentId, 'C1');
  assert.equal(res.suggestions.length, 1);
  assert.equal(res.review.status, 'succeeded');
});

test('reviewPost updates an existing post found by slug', async () => {
  const { client, calls } = fakeClient({ findBySlug: async () => ({ content_id: 'C9' }) });
  const res = await reviewPost(client, { slug: 'x', title: 'X', body: 'b' }, { sleep: async () => {}, attempts: 5 });
  assert.equal(calls[0][0], 'update');
  assert.equal(calls[0][1], 'C9');
  assert.equal(res.contentId, 'C9');
});

test('reviewPost passes the platform through to startReview', async () => {
  const { client, calls } = fakeClient();
  await reviewPost(client, { slug: 'x', title: 'X', body: 'b' }, { sleep: async () => {}, attempts: 5, platform: 'blog' });
  const start = calls.find((c) => c[0] === 'startReview');
  assert.deepEqual(start, ['startReview', 'C1', 'blog']);
});

test('reviewPost returns only this run’s suggestions (by review_id)', async () => {
  const { client } = fakeClient({
    getSuggestions: async () => ({
      suggestions: [
        { id: 's1', review_id: 'R1' }, // this run
        { id: 'stale', review_id: 'OLD' }, // a previous, still-pending review
      ],
      review: { id: 'R1', status: 'succeeded' },
    }),
  });
  const res = await reviewPost(client, { slug: 'x', title: 'X', body: 'b' }, { sleep: async () => {}, attempts: 5 });
  assert.deepEqual(res.suggestions.map((s) => s.id), ['s1']);
});

test('reviewPost stops polling after attempts even if never terminal', async () => {
  let polls = 0;
  const { client } = fakeClient({ getReview: async () => { polls += 1; return { id: 'R1', status: 'running' }; } });
  await reviewPost(client, { slug: 'x', title: 'X', body: 'b' }, { sleep: async () => {}, attempts: 3 });
  assert.equal(polls, 3);
});

test('buildComments splits inline (diffed lines) from summary (off-diff)', () => {
  const file = 'The quick brown fox.\nThe lazy dog sleeps.';
  const suggestions = [
    { id: 's1', type: 'grammar', reason: 'x', start_offset: 4, end_offset: 9, text_to_replace: 'quick', replace_with: 'swift' }, // line 1
    { id: 's2', type: 'llm', reason: 'y', start_offset: file.indexOf('lazy'), end_offset: file.indexOf('lazy') + 4, text_to_replace: 'lazy', replace_with: 'sleepy' }, // line 2
  ];
  const { inline, summary, inlineSummary } = buildComments({
    fileText: file, bodyOffset: 0, suggestions, commentable: new Set([1]), path: 'p/a.md',
  });
  assert.equal(inline.length, 1);
  assert.equal(inline[0].line, 1);
  assert.match(inline[0].body, /```suggestion\nThe swift brown fox.\n```/);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].id, 's2');
  // The inline suggestion is also available in summary form as a fallback.
  assert.equal(inlineSummary.length, 1);
  assert.equal(inlineSummary[0].id, 's1');
});

test('renderSummary carries the marker, verdict, and off-diff suggestions', () => {
  const md = renderSummary([
    {
      path: 'p/a.md',
      review: { summary: 'Looks solid.', lenses: { verdict: 'minor_revisions' } },
      summary: [{ type: 'llm', startLine: 5, endLine: 5, reason: 'buzzword', text_to_replace: 'leverage', replace_with: 'use' }],
    },
  ]);
  assert.ok(md.includes(SUMMARY_MARKER));
  assert.match(md, /minor revisions/);
  assert.match(md, /Looks solid\./);
  assert.match(md, /leverage.*→.*use/);
});
