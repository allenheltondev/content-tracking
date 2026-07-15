// Feed discovery helpers for Content Radar capture. Pure functions with no
// chrome/DOM dependencies so they unit-test cleanly and can be reused from the
// popup. The raw link data they consume is collected in-page by a small
// self-contained function injected via chrome.scripting (see popup.js) — that
// injected code must stand alone, so all the normalization lives here instead.
//
// Content Radar sources are RSS/Atom *feed* URLs, not article URLs (the API
// fetches and parses them server-side). So "add this page" means: discover the
// site's feed from its <link rel="alternate"> tags and add that.

// RSS/Atom feed link types we recognize on a page. RDF (rss+xml) and Atom
// cover the real world; the JSON Feed type is included since some blogs expose
// only that and the server parser tolerates what it can't read anyway.
const FEED_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/rdf+xml",
  "application/feed+json",
  "application/json",
]);

function feedKind(type) {
  const t = (type || "").toLowerCase();
  if (t.includes("atom")) return "atom";
  if (t.includes("json")) return "json";
  return "rss";
}

// Resolve a possibly-relative href against the page URL and keep only public
// http(s) targets. Returns the absolute URL string, or null if it can't be
// resolved or isn't http(s) (a feed can't be javascript:/data:/relative-to-
// nothing). The server re-guards against SSRF, but there's no reason to send it
// a URL we already know it will reject.
export function resolveFeedUrl(href, baseUrl) {
  if (typeof href !== "string" || href.trim().length === 0) return null;
  let resolved;
  try {
    resolved = baseUrl ? new URL(href, baseUrl) : new URL(href);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  return resolved.toString();
}

// Normalize two feed URLs for equality so the popup can tell "already on your
// radar" from "new". Compares origin + path + search with a trailing slash and
// case-folded host removed; ignores the fragment. Falls back to a trimmed
// lowercase string compare for anything unparseable.
export function feedUrlKey(url) {
  if (typeof url !== "string") return "";
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function sameFeed(a, b) {
  const ka = feedUrlKey(a);
  return ka.length > 0 && ka === feedUrlKey(b);
}

// Turn the raw page data (collected in-page) into a de-duplicated list of feed
// candidates, newest-first is irrelevant here — order follows the page. Each
// candidate carries a display title and a kind (rss/atom/json). Also derives a
// site title used to label the source when a feed link has no title of its own.
//
// `links` is an array of { rel, type, href, title } lifted straight off the
// page's <link> elements. `baseUrl` is the page's own location.href.
export function normalizeDiscoveredFeeds({ links, baseUrl, pageTitle, siteName } = {}) {
  const siteTitle = firstNonEmpty([siteName, pageTitle]) || null;
  const out = [];
  const seen = new Set();

  for (const link of Array.isArray(links) ? links : []) {
    if (!link || typeof link !== "object") continue;
    const rel = (link.rel || "").toLowerCase();
    // rel is a space-separated token list; feed links use "alternate".
    if (!rel.split(/\s+/).includes("alternate")) continue;
    if (!FEED_TYPES.has((link.type || "").toLowerCase())) continue;

    const url = resolveFeedUrl(link.href, baseUrl);
    if (!url) continue;

    const key = feedUrlKey(url);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      url,
      title: firstNonEmpty([link.title, siteTitle]) || url,
      kind: feedKind(link.type),
    });
  }

  return { feeds: out, siteTitle };
}

function firstNonEmpty(values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}
