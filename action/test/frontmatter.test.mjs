import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontMatter, postFields } from '../src/frontmatter.mjs';

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

test('postFields flags drafts', () => {
  assert.equal(postFields('---\ndraft: true\n---\nx', 'p/a.md').draft, true);
  assert.equal(postFields('---\ndraft: false\n---\nx', 'p/a.md').draft, false);
  assert.equal(postFields('no fm', 'p/a.md').draft, false);
});
