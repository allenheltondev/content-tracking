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

// Minimal `key = value` reader for the scalar fields Hugo TOML front matter
// carries (title/slug/draft/date). Not a full TOML parser — arrays/tables are
// ignored, which is fine since we only read scalars.
function parseTomlScalars(inner) {
  const out = {};
  for (const line of inner.split('\n')) {
    const kv = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    let val = kv[2];
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    else if (val === 'true') val = true;
    else if (val === 'false') val = false;
    out[kv[1]] = val;
  }
  return out;
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

export function postFields(fileText, filePath) {
  const { data, bodyOffset, body } = splitFrontMatter(fileText);
  const fileSlug = filePath.split('/').pop().replace(/\.m(d|arkdown)$/i, '');
  const rawSlug = typeof data.slug === 'string' && data.slug ? data.slug : fileSlug;
  return {
    // Fall back to the (normalized) filename if the front-matter slug reduces to
    // nothing — e.g. `slug: /`.
    slug: toBookedSlug(rawSlug) || toBookedSlug(fileSlug),
    title: typeof data.title === 'string' ? data.title : fileSlug,
    draft: data.draft === true,
    date: typeof data.date === 'string' ? data.date : undefined,
    body,
    bodyOffset,
  };
}
