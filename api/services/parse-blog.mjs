import { remark } from "remark";
import { visit } from "unist-util-visit";

// Reformats a blog's Markdown body for a target platform. Pure module:
// no I/O, no DynamoDB — the cross-post durable function calls it inside a
// step with the blog and the tenant's catalog. Rebuild of the legacy
// blog-service parse-blog, with the documented fixes:
//
//  - Cross-links are rewritten via a Markdown AST (remark), so only true
//    link nodes are touched — never parenthetical prose or links inside
//    code fences (the legacy `\(([^)]*)\)` regex hit all of those).
//  - Every occurrence of a repeated link target is rewritten (the legacy
//    String.replace only swapped the first).
//  - The Medium header omits the description/hero lines when those fields
//    are absent (the legacy emitted empty `#### ` / `![](undefined)`).
//  - Path-only catalog matches are restricted to relative links or
//    same-host absolute links, so an external URL that merely shares a
//    path is never rewritten to this tenant's copy.
//  - Query strings and #fragments on a cross-link are carried through to
//    the rewritten URL, so deep links survive cross-posting.
//
// Tweets stay a text transform: they are Hugo shortcodes, not Markdown
// links, so the AST doesn't model them.

export const BLOG_PLATFORMS = ["dev", "medium", "hashnode"];

const TWEET_RE = /\{\{<\s*tweet\s+user="([a-zA-Z0-9_]+)"\s+id="(\d+)"\s*>\}\}/g;

// Returns { body, tags } for the platform. `catalog` is the tenant's blog
// list (each with links/canonicalUrl) used to keep cross-links on-platform.
// `baseUrl` is the tenant's canonical base URL, used only as a last-resort
// prefix for a catalog entry that stored a relative canonical.
export function transformBlogForPlatform({ blog, catalog = [], platform, baseUrl }) {
  if (!BLOG_PLATFORMS.includes(platform)) {
    throw new Error(`Unknown platform "${platform}"`);
  }

  const linked = rewriteCrossLinks(blog.contentMarkdown ?? "", catalog, platform, baseUrl);
  const tweeted = replaceTweets(linked, platform);
  const body = composeBody(tweeted, blog, platform);
  const tags = assembleTags(blog, platform);

  return { body, tags };
}

// --- cross-link rewriting (AST) ---------------------------------------

function rewriteCrossLinks(md, catalog, platform, baseUrl) {
  if (!md) return md;

  const tree = remark().parse(md);

  // Collect link nodes once, keyed by start offset so a node is never
  // processed twice.
  const byOffset = new Map();
  visit(tree, "link", (node) => {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (typeof start !== "number" || typeof end !== "number") return;
    if (!byOffset.has(start)) {
      byOffset.set(start, { start, end, url: node.url });
    }
  });

  const replacements = [];
  for (const link of byOffset.values()) {
    const newUrl = resolveCrossLink(link.url, catalog, platform, baseUrl);
    if (newUrl && newUrl !== link.url) {
      replacements.push({ ...link, newUrl });
    }
  }

  // Apply from the end so earlier offsets stay valid. Replace only the URL
  // inside the link's own source span — never anything else in the doc.
  replacements.sort((a, b) => b.start - a.start);
  let out = md;
  for (const r of replacements) {
    const span = out.slice(r.start, r.end);
    let newSpan = span;
    if (span.includes(`](${r.url}`)) {
      newSpan = span.replace(`](${r.url}`, `](${r.newUrl}`);
    } else if (span.includes(`<${r.url}>`)) {
      newSpan = span.replace(`<${r.url}>`, `<${r.newUrl}>`);
    }
    out = out.slice(0, r.start) + newSpan + out.slice(r.end);
  }
  return out;
}

// If the link points at another catalogued blog, swap it for that blog's
// native copy on the current platform, else its absolute canonical URL.
// Any query string / fragment on the original link is carried through so
// deep links (e.g. #section anchors) survive cross-posting. Returns the
// original target when there is no catalog match.
function resolveCrossLink(target, catalog, platform, baseUrl) {
  const entry = catalog.find((c) => matchesCanonical(target, c, baseUrl));
  if (!entry) return target;
  const base = entry.links?.[platform] ?? absoluteCanonical(entry, baseUrl);
  if (!base) return target;
  const { search, hash } = parseTarget(target);
  return `${base}${search}${hash}`;
}

// A link matches a catalog entry when it points at the same post. An exact
// string match always counts. A path-only match is allowed ONLY for
// relative links, or absolute links on the same host as the entry's
// canonical (or the tenant base URL) — otherwise an external link that
// merely shares a path (e.g. https://partner.example/blog/sqs) would be
// wrongly rewritten to this tenant's copy.
function matchesCanonical(target, entry, baseUrl) {
  const entryUrl = entry?.links?.url ?? entry?.canonicalUrl;
  if (!entryUrl || !target) return false;
  if (target === entryUrl) return true;

  const t = parseTarget(target);
  const e = parseTarget(entryUrl);
  if (t.path === null || e.path === null || t.path !== e.path) return false;

  if (!t.absolute) return true; // relative link → same site by definition

  const allowedHosts = new Set();
  if (e.absolute) allowedHosts.add(e.host);
  const baseHost = baseUrl ? parseTarget(baseUrl).host : null;
  if (baseHost) allowedHosts.add(baseHost);
  return allowedHosts.has(t.host);
}

function absoluteCanonical(entry, baseUrl) {
  const canonical = entry?.canonicalUrl ?? entry?.links?.url;
  if (!canonical) return null;
  if (parseTarget(canonical).absolute) return canonical;
  if (!baseUrl) return canonical;
  return `${baseUrl.replace(/\/+$/, "")}/${canonical.replace(/^\/+/, "")}`;
}

// Splits a URL or bare path into { absolute, host, path, search, hash }
// without throwing on relative inputs. `path` is null for empty input.
function parseTarget(u) {
  if (typeof u !== "string" || u.length === 0) {
    return { absolute: false, host: null, path: null, search: "", hash: "" };
  }
  try {
    const url = new URL(u);
    return { absolute: true, host: url.host, path: url.pathname, search: url.search, hash: url.hash };
  } catch {
    const hashIdx = u.indexOf("#");
    const hash = hashIdx >= 0 ? u.slice(hashIdx) : "";
    const rest = hashIdx >= 0 ? u.slice(0, hashIdx) : u;
    const qIdx = rest.indexOf("?");
    const search = qIdx >= 0 ? rest.slice(qIdx) : "";
    const path = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
    return { absolute: false, host: null, path, search, hash };
  }
}

// --- tweets ------------------------------------------------------------

function replaceTweets(md, platform) {
  return md.replace(TWEET_RE, (_match, user, id) => {
    const url = `https://twitter.com/${user}/status/${id}`;
    if (platform === "dev") return `{% twitter ${url} %}`;
    if (platform === "hashnode") return `%[${url}]`;
    return url; // medium: bare URL
  });
}

// --- body composition --------------------------------------------------

function composeBody(body, blog, platform) {
  if (platform !== "medium") return body;

  // Medium has no separate title/description/cover fields on the API, so
  // they are folded into the content. Insert a horizontal rule before each
  // H2 to visually separate sections (matches the legacy behavior).
  let header = `\n# ${blog.title}\n`;
  if (blog.description) header += `#### ${blog.description}\n`;
  if (blog.image) header += `![${blog.imageAttribution ?? ""}](${blog.image})\n`;

  return (header + body).replace(/\n\n## /g, "\n\n---\n\n## ");
}

// --- tags --------------------------------------------------------------

// categories + tags, deduped (case-insensitive, first spelling wins).
// Dev.to and Hashnode strip spaces; Medium passes through unchanged. The
// Hashnode adapter maps these strings to its {slug,name} shape.
function assembleTags(blog, platform) {
  const combined = [...(blog.categories ?? []), ...(blog.tags ?? [])];
  const shaped = platform === "medium" ? combined : combined.map((t) => t.replace(/\s+/g, ""));

  const seen = new Set();
  const out = [];
  for (const tag of shaped) {
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}
