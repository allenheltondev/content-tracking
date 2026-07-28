import test from 'node:test';
import assert from 'node:assert/strict';
import { contentPayload, permalinkPath, canonicalFor, publishPost } from '../src/publish.mjs';
import { postFields } from '../src/frontmatter.mjs';

const POST = {
  slug: 'my-post',
  title: 'My Post',
  body: 'The body.',
  description: 'A post about things.',
  tags: ['serverless'],
  categories: ['engineering'],
  publishDate: '2026-07-18',
  path: 'content/blog/my-post.md',
};

function fakeClient(overrides = {}) {
  const calls = [];
  const base = {
    findBySlug: async () => null,
    createContent: async (f) => { calls.push(['create', f]); return { content_id: 'C1' }; },
    updateContent: async (id, f) => { calls.push(['update', id, f]); return { content_id: id }; },
  };
  return { client: { ...base, ...overrides }, calls };
}

test('contentPayload publishes with the full metadata set', () => {
  const payload = contentPayload(POST, { canonicalUrl: 'https://example.com/blog/my-post/' });
  assert.deepEqual(payload, {
    title: 'My Post',
    slug: 'my-post',
    type: 'blog',
    source: 'owned',
    status: 'published',
    content_markdown: 'The body.',
    description: 'A post about things.',
    tags: ['serverless'],
    categories: ['engineering'],
    publish_date: '2026-07-18',
    canonical_url: 'https://example.com/blog/my-post/',
  });
});

test('contentPayload omits absent metadata on create but clears it on update', () => {
  const bare = { slug: 'x', title: 'X', body: 'b', tags: [], categories: [] };

  const created = contentPayload(bare);
  assert.equal('description' in created, false);
  assert.equal('publish_date' in created, false);

  // The merged file is the source of truth: metadata deleted from front matter
  // is cleared in Booked rather than left behind.
  const updated = contentPayload(bare, { forUpdate: true });
  assert.equal(updated.description, null);
  assert.equal(updated.tags, null);
  assert.equal(updated.categories, null);
  assert.equal(updated.publish_date, null);
});

test('contentPayload never clears canonical_url or touches campaign_id', () => {
  const updated = contentPayload({ ...POST, canonicalUrl: undefined }, { forUpdate: true });
  assert.equal('canonical_url' in updated, false);
  assert.equal('campaign_id' in updated, false);
});

test('permalinkPath maps a post to its section path plus slug', () => {
  assert.equal(permalinkPath(POST, 'content/'), 'blog/my-post');
  // A page bundle: the directory is the page, so the slug replaces it.
  assert.equal(
    permalinkPath({ slug: 'my-post', path: 'content/blog/my-post/index.md' }, 'content/'),
    'blog/my-post',
  );
  // A front-matter slug that differs from the filename wins.
  assert.equal(
    permalinkPath({ slug: 'renamed', path: 'content/blog/original-name.md' }, 'content/'),
    'blog/renamed',
  );
});

test('canonicalFor stores a path by default, so the base URL stays in Settings', () => {
  assert.equal(canonicalFor(POST, { postsDir: 'content/' }), '/blog/my-post/');
  // A front-matter `url` is a permalink override.
  assert.equal(canonicalFor({ ...POST, urlPath: '/2026/my-post/' }, { postsDir: 'content/' }), '/2026/my-post/');
});

test('canonicalFor goes absolute for an explicit front-matter URL or site-url', () => {
  // The piece's canonical lives elsewhere: taken as written, site-url or not.
  assert.equal(
    canonicalFor({ ...POST, canonicalUrl: 'https://elsewhere.dev/canonical/' }, { siteUrl: 'https://example.com' }),
    'https://elsewhere.dev/canonical/',
  );
  assert.equal(
    canonicalFor(POST, { siteUrl: 'https://example.com/', postsDir: 'content/' }),
    'https://example.com/blog/my-post/',
  );
});

test('publishPost updates the record a review PR already created', async () => {
  const { client, calls } = fakeClient({ findBySlug: async () => ({ content_id: 'C9' }) });
  const res = await publishPost(client, POST, { siteUrl: 'https://example.com', postsDir: 'content/' });

  assert.equal(res.created, false);
  assert.equal(res.contentId, 'C9');
  assert.deepEqual(calls[0].slice(0, 2), ['update', 'C9']);
  assert.equal(calls[0][2].status, 'published');
  assert.equal(calls[0][2].publish_date, '2026-07-18');
  assert.equal(calls[0][2].canonical_url, 'https://example.com/blog/my-post/');
});

test('publishPost creates a post that never went through a review PR', async () => {
  const { client, calls } = fakeClient();
  const res = await publishPost(client, POST, { postsDir: 'content/' });

  assert.equal(res.created, true);
  assert.equal(res.contentId, 'C1');
  assert.equal(calls[0][0], 'create');
  assert.equal(calls[0][1].status, 'published');
  assert.equal(calls[0][1].type, 'blog');
  // No site-url: the canonical goes in as a path for Booked to resolve.
  assert.equal(calls[0][1].canonical_url, '/blog/my-post/');
});

test('a real Hugo post publishes with its date as the voice anchor', async () => {
  const file = [
    '---',
    'title: Shipping Fast',
    'date: 2026-07-18T09:00:00-05:00',
    'description: How we ship.',
    'tags:',
    '  - serverless',
    '  - aws',
    '---',
    '',
    'The body.',
  ].join('\n');

  const { client, calls } = fakeClient();
  await publishPost(client, postFields(file, 'content/blog/shipping-fast.md'), {
    siteUrl: 'https://example.com',
    postsDir: 'content/',
  });

  const payload = calls[0][1];
  assert.equal(payload.slug, 'shipping-fast');
  assert.equal(payload.title, 'Shipping Fast');
  assert.equal(payload.publish_date, '2026-07-18');
  assert.deepEqual(payload.tags, ['serverless', 'aws']);
  assert.equal(payload.description, 'How we ship.');
  assert.equal(payload.canonical_url, 'https://example.com/blog/shipping-fast/');
  // The body is everything after the front-matter block, blank line included —
  // the same string the review's suggestion offsets index into.
  assert.equal(payload.content_markdown, '\nThe body.');
});
