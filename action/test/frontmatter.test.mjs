import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontMatter, postFields, toBookedSlug } from '../src/frontmatter.mjs';

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
