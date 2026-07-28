import matter from 'gray-matter';

// Front matter delimiters Hugo supports (YAML ---, TOML +++). JSON front matter
// ({ ... }) is rarer; add it here if needed. Group 2 is the inner block.
const FM_RE = /^(---|\+\+\+)\r?\n([\s\S]*?)\r?\n\1[ \t]*\r?\n?/;

// Splits a Hugo post file into its parsed front-matter data and its body,
// returning the body's byte offset in the file. We compute the offset ourselves
// (rather than trusting a library's trimmed content) and define the body as
// `fileText.slice(bodyOffset)` so the exact string we send to Booked as
// content_markdown is the same string the review's suggestion offsets index
// into — that alignment is what makes offset→line mapping correct.
export function splitFrontMatter(fileText) {
  const m = FM_RE.exec(fileText);
  const bodyOffset = m ? m[0].length : 0;
  const body = fileText.slice(bodyOffset);

  let data = {};
  if (m) {
    if (m[1] === '+++') {
      // gray-matter needs an engine for TOML; we only read a few scalar fields,
      // so parse `key = value` lines directly rather than pull in a TOML dep.
      data = parseTomlScalars(m[2]);
    } else {
      try { data = matter(fileText).data ?? {}; } catch { data = {}; }
    }
  }
  return { data, bodyOffset, body };
}

// Minimal `key = value` reader for the fields Hugo TOML front matter carries
// (title/slug/draft/date, plus single-line tags/categories arrays). Not a full
// TOML parser — tables and multi-line arrays are ignored, which is fine for the
// handful of values we read.
function parseTomlScalars(inner) {
  const out = {};
  for (const line of inner.split('\n')) {
    const kv = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    let val = kv[2];
    if (/^\[.*\]$/.test(val)) val = parseTomlInlineArray(val);
    else if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    else if (val === 'true') val = true;
    else if (val === 'false') val = false;
    out[kv[1]] = val;
  }
  return out;
}

// `["a", "b"]` → ['a', 'b']. Entries are quoted strings in every Hugo front
// matter we care about (tags, categories); anything else is left as written.
function parseTomlInlineArray(value) {
  return value
    .slice(1, -1)
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter((entry) => entry.length > 0);
}

// Derives the fields Booked needs from a post's front matter + path. Hugo's
// slug defaults to the filename (without extension) when not set explicitly.
// Booked stores slugs as flat kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), but a
// Hugo `slug` is frequently a path — `/section/my-post`, or a site's own scheme
// like `/author.name/my-post-abc123`. Sending that raw makes `POST /content`
// 400 on slug validation. Take the last path segment and kebab-normalize it so
// the value we register (and later look up) is one Booked accepts.
export function toBookedSlug(raw) {
  const segment = String(raw ?? '').split('/').filter(Boolean).pop() ?? '';
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Booked's publish_date is a plain calendar day. Hugo dates arrive either as a
// string or — for unquoted YAML dates — already parsed into a Date by
// gray-matter, so both shapes normalize here. A date carrying a zone is read as
// its UTC day; the voice's recency curve has a 90-day half-life, so a
// day-boundary rounding is noise.
export function toIsoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const plain = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    if (plain) return plain[1];
    const parsed = Date.parse(value.trim());
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  return undefined;
}

// Booked caps tags/categories at 30 entries of 50 chars and rejects the whole
// request past that, so normalize here rather than let a tag-happy post 400 the
// publish: strings only, trimmed, de-duplicated, over-long ones and the tail
// past 30 dropped.
const TAG_MAX = 50;
const TAGS_MAX_COUNT = 30;
export function normalizeTags(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out = [];
  for (const raw of list) {
    const tag = typeof raw === 'string' ? raw.trim() : '';
    if (!tag || tag.length > TAG_MAX || out.includes(tag)) continue;
    out.push(tag);
    if (out.length === TAGS_MAX_COUNT) break;
  }
  return out;
}

const firstString = (...values) => values.find((v) => typeof v === 'string' && v.trim().length > 0)?.trim();
const isAbsoluteUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v.trim());

// The slug Hugo would use for the file itself: its basename, except for a page
// bundle (`my-post/index.md`), where the page IS the directory and the basename
// carries no identity.
function fileSlugFor(filePath) {
  const parts = String(filePath).split('/').filter(Boolean);
  const base = (parts.pop() ?? '').replace(/\.m(d|arkdown)$/i, '');
  if (base === 'index' || base === '_index') return parts.pop() ?? base;
  return base;
}

export function postFields(fileText, filePath) {
  const { data, bodyOffset, body } = splitFrontMatter(fileText);
  const fileSlug = fileSlugFor(filePath);
  const rawSlug = typeof data.slug === 'string' && data.slug ? data.slug : fileSlug;
  const rawUrl = firstString(data.canonicalURL, data.canonical_url, data.canonicalUrl, data.url);
  // A front-matter slug carrying path segments ("/allen.helton/my-post") is the
  // post's whole URL path on the site, not just its last segment. Booked stores
  // the flattened kebab slug, so keep the raw value to build the canonical
  // from: rebuilding it from the file's directory instead would point readers
  // at a path the post isn't served on.
  const slugPath = typeof data.slug === "string" && data.slug.includes('/') ? data.slug : undefined;
  return {
    // Fall back to the (normalized) filename if the front-matter slug reduces to
    // nothing — e.g. `slug: /`.
    slug: toBookedSlug(rawSlug) || toBookedSlug(fileSlug),
    title: typeof data.title === 'string' ? data.title : fileSlug,
    draft: data.draft === true,
    date: typeof data.date === 'string' ? data.date : undefined,
    // Metadata mirrored onto the Booked record when a merge publishes the post.
    // `publishDate` anchors the voice recency curve, so prefer Hugo's explicit
    // publication date over the page's `date` when a post carries both — for a
    // scheduled or backfilled piece they differ, and it's the publication date
    // that says when the writing shipped.
    publishDate: toIsoDate(data.publishDate ?? data.publishdate ?? data.pubdate ?? data.date),
    description: firstString(data.description, data.summary),
    tags: normalizeTags(data.tags),
    categories: normalizeTags(data.categories),
    // An absolute front-matter URL is the canonical one as written; a relative
    // `url` (or a path-style slug) is the post's own path on the site.
    canonicalUrl: isAbsoluteUrl(rawUrl) ? rawUrl : undefined,
    urlPath: (rawUrl && !isAbsoluteUrl(rawUrl) ? rawUrl : undefined) ?? slugPath,
    path: filePath,
    body,
    bodyOffset,
  };
}
