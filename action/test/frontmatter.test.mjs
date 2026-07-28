import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontMatter, postFields, toBookedSlug, toIsoDate, normalizeTags } from '../src/frontmatter.mjs';

test('splits YAML front matter and returns the body offset', () => {
  const file = '---\ntitle: Hi\nslug: my-post\n---\nThe body.\n';
  const { data, bodyOffset, body } = splitFrontMatter(file);
  assert.equal(data.title, 'Hi');
  assert.equal(data.slug, 'my-post');
  assert.equal(file.slice(bodyOffset), body);
  assert.equal(body, 'The body.\n');
});

test('splits TOML (+++) front matter', () => {
  const file = '+++\ntitle = "Hi"\n+++\nBody here.\n';
  const { data, body } = splitFrontMatter(file);
  assert.equal(data.title, 'Hi');
  assert.equal(body, 'Body here.\n');
});

test('handles a file with no front matter', () => {
  const file = 'Just body, no front matter.';
  const { data, bodyOffset, body } = splitFrontMatter(file);
  assert.deepEqual(data, {});
  assert.equal(bodyOffset, 0);
  assert.equal(body, file);
});

test('postFields derives slug from front matter, else the filename', () => {
  const withSlug = postFields('---\ntitle: A\nslug: chosen\n---\nx', 'content/posts/file-name.md');
  assert.equal(withSlug.slug, 'chosen');
  assert.equal(withSlug.title, 'A');

  const noSlug = postFields('---\ntitle: B\n---\nx', 'content/posts/file-name.md');
  assert.equal(noSlug.slug, 'file-name');
});

test('toBookedSlug reduces a path-style slug to a kebab last segment', () => {
  // Path-style Hugo slugs (a real ready-set-cloud shape) must not reach Booked
  // raw — the leading slash + dot fail slug validation.
  assert.equal(toBookedSlug('/allen.helton/8-steps-to-x-2324de48'), '8-steps-to-x-2324de48');
  assert.equal(toBookedSlug('/multi-agent-collaboration'), 'multi-agent-collaboration');
  assert.equal(toBookedSlug('section/My Post'), 'my-post');
  assert.equal(toBookedSlug('already-kebab'), 'already-kebab');
  const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  for (const s of ['/allen.helton/8-steps-to-x-2324de48', '/multi-agent-collaboration', 'section/My Post']) {
    assert.match(toBookedSlug(s), KEBAB);
  }
});

test('postFields normalizes a path-style front-matter slug', () => {
  const post = postFields(
    '---\ntitle: A\nslug: /allen.helton/design-to-delight-a1eec234\n---\nbody',
    'content/blog/2019-05-24_Design-to-Delight.md',
  );
  assert.equal(post.slug, 'design-to-delight-a1eec234');
});

test('postFields flags drafts', () => {
  assert.equal(postFields('---\ndraft: true\n---\nx', 'p/a.md').draft, true);
  assert.equal(postFields('---\ndraft: false\n---\nx', 'p/a.md').draft, false);
  assert.equal(postFields('no fm', 'p/a.md').draft, false);
});

test('toIsoDate normalizes the shapes Hugo front matter carries', () => {
  // Unquoted YAML dates reach us already parsed into a Date.
  assert.equal(toIsoDate(new Date('2026-07-18T14:00:00Z')), '2026-07-18');
  assert.equal(toIsoDate('2026-07-18'), '2026-07-18');
  assert.equal(toIsoDate('2026-07-18T09:00:00-05:00'), '2026-07-18');
  assert.equal(toIsoDate('July 18, 2026'), '2026-07-18');
  assert.equal(toIsoDate(undefined), undefined);
  assert.equal(toIsoDate('not a date'), undefined);
});

test('normalizeTags trims, de-dupes, and drops what Booked would reject', () => {
  assert.deepEqual(normalizeTags([' aws ', 'aws', 'serverless']), ['aws', 'serverless']);
  assert.deepEqual(normalizeTags('single'), ['single']);
  assert.deepEqual(normalizeTags(undefined), []);
  assert.deepEqual(normalizeTags(['ok', 'x'.repeat(51)]), ['ok']); // 50-char cap
  assert.equal(normalizeTags(Array.from({ length: 40 }, (_, i) => `t${i}`)).length, 30);
});

test('postFields carries the metadata a merge publishes', () => {
  const file = [
    '---',
    'title: Shipping Fast',
    'date: 2026-07-18',
    'summary: How we ship.',
    'tags: [serverless, aws]',
    'categories: [engineering]',
    '---',
    'body',
  ].join('\n');
  const post = postFields(file, 'content/blog/shipping-fast.md');

  assert.equal(post.publishDate, '2026-07-18');
  assert.equal(post.description, 'How we ship.');
  assert.deepEqual(post.tags, ['serverless', 'aws']);
  assert.deepEqual(post.categories, ['engineering']);
  assert.equal(post.path, 'content/blog/shipping-fast.md');
});

test('postFields splits an absolute canonical URL from a relative permalink', () => {
  const abs = postFields('---\ncanonicalURL: https://elsewhere.dev/p/\n---\nx', 'p/a.md');
  assert.equal(abs.canonicalUrl, 'https://elsewhere.dev/p/');
  assert.equal(abs.urlPath, undefined);

  const rel = postFields('---\nurl: /2026/my-post/\n---\nx', 'p/a.md');
  assert.equal(rel.canonicalUrl, undefined);
  assert.equal(rel.urlPath, '/2026/my-post/');
});

test('postFields names a page bundle after its directory, not index.md', () => {
  const post = postFields('---\ntitle: Bundled\n---\nx', 'content/blog/my-post/index.md');
  assert.equal(post.slug, 'my-post');
  assert.equal(postFields('---\ntitle: T\n---\nx', 'content/blog/other/_index.md').slug, 'other');
});

test('TOML front matter reads single-line tag arrays', () => {
  const file = '+++\ntitle = "Hi"\ndate = 2026-07-18\ntags = ["aws", "serverless"]\n+++\nbody';
  const post = postFields(file, 'content/blog/hi.md');
  assert.deepEqual(post.tags, ['aws', 'serverless']);
  assert.equal(post.publishDate, '2026-07-18');
});
