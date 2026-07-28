// The merge half of the action: once a post lands on the default branch it is
// no longer a draft under review, so its Booked record is brought fully in line
// with the merged file — final body, final metadata, status `published`.
//
// Setting status to `published` on a `blog` record is also what starts the
// voice learning pipeline: the content stream picks the row up, captures it as
// a voice sample anchored on its publish date, and that feeds embedding,
// counting, and (at the threshold) reflection. Nothing here calls voice
// directly — publishing the post IS the trigger, which is why `publish_date`
// matters: it is the sample's position on the recency-decay curve, and without
// it the sample falls back to when the row happened to be created.

// The fields the repo owns. Metadata the file no longer carries is cleared
// (null) on update so deleting a tag or description in the repo takes effect in
// Booked — the merged file is the source of truth for these. Two fields are
// deliberately NOT in that set: `canonical_url` is only ever set, never
// cleared, since it can legitimately be filled in from the app when the site
// doesn't declare one; and `campaign_id` is app-owned linkage this action must
// never touch.
export function contentPayload(post, { canonicalUrl, forUpdate = false } = {}) {
  const clear = forUpdate ? null : undefined;
  const payload = {
    title: post.title,
    slug: post.slug,
    type: 'blog',
    source: 'owned',
    status: 'published',
    content_markdown: post.body,
    description: post.description ?? clear,
    tags: post.tags?.length ? post.tags : clear,
    categories: post.categories?.length ? post.categories : clear,
    publish_date: post.publishDate ?? clear,
    ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
  };
  // `undefined` on create means "field absent"; strip so it isn't serialized.
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) delete payload[key];
  }
  return payload;
}

// Hugo's default permalink for a page is its section path plus its slug
// (`content/blog/my-post.md` → `/blog/my-post/`), and a page bundle's directory
// is the page itself. Sites that override `permalinks` in config can say so per
// post with a front-matter `url`, which wins over this.
export function permalinkPath(post, postsDir = '') {
  const prefix = String(postsDir).replace(/^\.?\/*/, '').replace(/\/*$/, '');
  let rel = String(post.path ?? '');
  if (prefix && rel.startsWith(`${prefix}/`)) rel = rel.slice(prefix.length + 1);

  const segments = rel.split('/').filter(Boolean);
  const file = (segments.pop() ?? '').replace(/\.m(d|arkdown)$/i, '');
  // A page bundle's last directory names the page, and the slug already carries
  // that name — drop it so the path isn't doubled.
  if ((file === 'index' || file === '_index') && segments.length > 0) segments.pop();

  return [...segments, post.slug].filter(Boolean).join('/');
}

// The post's canonical URL, or undefined when there isn't enough to build one.
// An absolute front-matter URL is taken as written; otherwise the site's base
// URL is joined with the post's permalink.
export function canonicalUrlFor(post, { siteUrl, postsDir } = {}) {
  if (post.canonicalUrl) return post.canonicalUrl;
  if (!siteUrl) return undefined;

  const base = String(siteUrl).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return undefined;

  const path = (post.urlPath ?? permalinkPath(post, postsDir)).replace(/^\/+|\/+$/g, '');
  return path ? `${base}/${path}/` : undefined;
}

// Brings a merged post's Booked record to its published state, creating it if
// the post never went through a review PR. Returns what happened so the caller
// can report it.
export async function publishPost(client, post, { siteUrl, postsDir } = {}) {
  const canonicalUrl = canonicalUrlFor(post, { siteUrl, postsDir });
  const existing = await client.findBySlug(post.slug);

  if (existing) {
    const content = await client.updateContent(
      existing.content_id,
      contentPayload(post, { canonicalUrl, forUpdate: true }),
    );
    return { contentId: existing.content_id, created: false, canonicalUrl, content };
  }

  const content = await client.createContent(contentPayload(post, { canonicalUrl }));
  return { contentId: content.content_id, created: true, canonicalUrl, content };
}
