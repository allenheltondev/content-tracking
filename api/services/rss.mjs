import { logger } from "./logger.mjs";
import { htmlToText, isPublicHttpUrl } from "./content-fetch.mjs";

// Fetches and parses the RSS/Atom feeds a creator subscribes to, so the
// content-radar agent can reason over what the wider world is publishing
// right now. The parser is deliberately dependency-free (a few targeted
// regex passes, mirroring content-fetch's htmlToText) — feeds are noisy but
// their item structure is simple and stable, and pulling in an XML library
// for it isn't worth the weight.
//
// Everything here is best-effort and defensive: a feed that 404s, times out,
// returns HTML instead of XML, or is malformed must not break the aggregate —
// it just contributes nothing and is reported as failed so the UI can flag it.

// Bounds so one pathological feed can't blow up memory or token usage.
const MAX_FEED_BYTES = 5_000_000; // ~5 MB of XML is already an outlier
const MAX_ITEMS_PER_FEED = 50;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_TITLE_CHARS = 500;
const FETCH_TIMEOUT_MS = 8_000;

// Some feed hosts / CDNs reject the default undici agent string. We're
// fetching a public feed the user explicitly subscribed to, so identifying as
// a normal feed reader is appropriate.
const USER_AGENT =
  "Mozilla/5.0 (compatible; BookedContentRadar/1.0; +https://readysetcloud.io)";

const FEED_CONTENT_TYPE_RE =
  /application\/(rss\+xml|atom\+xml|xml|rdf\+xml)|text\/xml|text\/html|text\/plain/i;

// Fetches a single feed URL and returns { feedTitle, items }. Throws on any
// failure (bad URL, network error, non-OK status, unparseable body) so the
// aggregator can record per-feed health; callers that want a single feed
// standalone should catch. Item shape:
//   { title, link, summary, author, publishedAt, guid }
// publishedAt is an ISO 8601 string when the feed's date parses, else null.
export async function fetchFeed(url) {
  if (!isPublicHttpUrl(url)) {
    // The URL is user-supplied, so this GET is an SSRF vector. Reject the
    // obvious internal/metadata targets before making any request.
    throw new Error(`Refusing to fetch non-public feed URL: ${url}`);
  }

  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
      },
    });
  } catch (err) {
    throw new Error(`Feed fetch failed: ${err?.message ?? "network error"}`, { cause: err });
  }

  if (!response.ok) {
    throw new Error(`Feed responded ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  // Feeds are frequently served with a generic or wrong content-type, so this
  // is a loose gate — we reject only obvious non-text (images, downloads) and
  // let the parser be the real arbiter of whether the body is a feed.
  if (contentType && !FEED_CONTENT_TYPE_RE.test(contentType)) {
    throw new Error(`Feed returned unexpected content-type: ${contentType}`);
  }

  let xml;
  try {
    xml = await response.text();
  } catch (err) {
    throw new Error(`Reading feed body failed: ${err?.message ?? "unknown"}`, { cause: err });
  }

  if (xml.length > MAX_FEED_BYTES) {
    xml = xml.slice(0, MAX_FEED_BYTES);
  }

  const parsed = parseFeed(xml);
  if (!parsed) {
    throw new Error("Response did not look like an RSS or Atom feed");
  }
  return parsed;
}

// Parses an RSS 2.0 / RDF / Atom document string into { feedTitle, items }.
// Pure and side-effect free so it's unit-testable without a network. Returns
// null when the body contains no recognizable feed items.
export function parseFeed(xml) {
  if (typeof xml !== "string" || xml.length === 0) return null;

  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const itemBlocks = isAtom ? matchAll(xml, /<entry[\s>][\s\S]*?<\/entry>/gi)
    : matchAll(xml, /<item[\s>][\s\S]*?<\/item>/gi);

  if (itemBlocks.length === 0) return null;

  // Feed title lives on the channel/feed element, before the first item. Slice
  // it off so an item's own <title> can't be mistaken for the feed title.
  const firstItemIdx = xml.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i);
  const head = firstItemIdx > 0 ? xml.slice(0, firstItemIdx) : xml;
  const feedTitle = tagText(head, "title");

  const items = [];
  for (const block of itemBlocks.slice(0, MAX_ITEMS_PER_FEED)) {
    const item = isAtom ? parseAtomEntry(block) : parseRssItem(block);
    if (item && (item.title || item.link || item.summary)) {
      items.push(item);
    }
  }

  if (items.length === 0) return null;
  return { feedTitle: feedTitle || null, items };
}

function parseRssItem(block) {
  const title = clip(tagText(block, "title"), MAX_TITLE_CHARS);
  const link = firstNonEmpty(tagText(block, "link"), attrOf(block, "link", "href"));
  // Prefer the short description; fall back to the full content:encoded body
  // (strip its HTML). Either way we clip so a giant post can't dominate.
  const summarySource = firstNonEmpty(
    tagText(block, "description"),
    tagText(block, "content:encoded"),
    tagText(block, "content"),
  );
  const summary = clip(stripHtml(summarySource), MAX_SUMMARY_CHARS);
  const author = firstNonEmpty(tagText(block, "dc:creator"), tagText(block, "author"));
  const publishedAt = normalizeDate(
    firstNonEmpty(tagText(block, "pubDate"), tagText(block, "dc:date"), tagText(block, "published")),
  );
  const guid = firstNonEmpty(tagText(block, "guid"), link) || null;
  return { title: title || null, link: link || null, summary: summary || null, author: author || null, publishedAt, guid };
}

function parseAtomEntry(block) {
  const title = clip(tagText(block, "title"), MAX_TITLE_CHARS);
  // Atom links are attributes. Prefer rel="alternate" (the human page); fall
  // back to the first link, then the raw <link> text some feeds still use.
  const link = firstNonEmpty(
    atomAlternateHref(block),
    attrOf(block, "link", "href"),
    tagText(block, "link"),
  );
  const summarySource = firstNonEmpty(tagText(block, "summary"), tagText(block, "content"));
  const summary = clip(stripHtml(summarySource), MAX_SUMMARY_CHARS);
  // Author name is nested: <author><name>…</name></author>.
  const authorBlock = matchFirst(block, /<author[\s>][\s\S]*?<\/author>/i);
  const author = authorBlock ? tagText(authorBlock, "name") : "";
  const publishedAt = normalizeDate(firstNonEmpty(tagText(block, "published"), tagText(block, "updated")));
  const guid = firstNonEmpty(tagText(block, "id"), link) || null;
  return { title: title || null, link: link || null, summary: summary || null, author: author || null, publishedAt, guid };
}

// Fetches every source concurrently and returns the merged, de-duplicated,
// newest-first item stream plus a per-source health result. Individual feed
// failures are isolated (Promise.allSettled) so a broken source never sinks
// the aggregate. `sources` is a list of { feedId, url, title? }.
//
// Returns:
//   {
//     items:   [{ ...item, feedId, feedTitle, sourceUrl }],   // capped, newest first
//     results: [{ feedId, url, ok, itemCount, feedTitle?, error? }],
//   }
export async function aggregateFeeds(sources, { limit = 60 } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const settled = await Promise.allSettled(list.map((s) => fetchFeed(s.url)));

  const results = [];
  const collected = [];
  settled.forEach((outcome, i) => {
    const source = list[i];
    if (outcome.status === "fulfilled") {
      const { feedTitle, items } = outcome.value;
      results.push({ feedId: source.feedId, url: source.url, ok: true, itemCount: items.length, feedTitle: feedTitle ?? null });
      for (const item of items) {
        collected.push({
          ...item,
          feedId: source.feedId,
          feedTitle: source.title || feedTitle || null,
          sourceUrl: source.url,
        });
      }
    } else {
      const error = outcome.reason?.message ?? "unknown error";
      logger.warn("Feed fetch failed during aggregation", { feedId: source.feedId, url: source.url, error });
      results.push({ feedId: source.feedId, url: source.url, ok: false, itemCount: 0, error });
    }
  });

  const deduped = dedupeItems(collected);
  deduped.sort((a, b) => itemTimestamp(b) - itemTimestamp(a));
  return { items: deduped.slice(0, limit), results };
}

// Drops repeats — the same story often appears in overlapping feeds. Keyed by
// guid when present, else the link, else title. The first occurrence wins
// (feeds are still in source order here, before the recency sort).
function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = (item.guid || item.link || item.title || "").trim().toLowerCase();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(item);
  }
  return out;
}

// Millisecond timestamp for recency sorting; missing/unparseable dates sort
// oldest so dated items float to the top.
function itemTimestamp(item) {
  const t = Date.parse(item.publishedAt ?? "");
  return Number.isNaN(t) ? 0 : t;
}

// --- small XML helpers -----------------------------------------------------

// Extracts the text of the first <tag>…</tag> in `block`, unwrapping CDATA and
// decoding entities. Tag name may contain a namespace colon (content:encoded).
function tagText(block, tag) {
  if (typeof block !== "string") return "";
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${esc}>`, "i");
  const m = block.match(re);
  return m ? decodeXml(unwrapCdata(m[1])).trim() : "";
}

// Reads an attribute off the first matching element, e.g. the href of <link>.
function attrOf(block, tag, attr) {
  if (typeof block !== "string") return "";
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${esc}\\b[^>]*\\b${attr}\\s*=\\s*["']([^"']+)["']`, "i");
  const m = block.match(re);
  return m ? decodeXml(m[1]).trim() : "";
}

// The atom <link rel="alternate"> (or a link with no rel, which defaults to
// alternate) is the canonical human URL for an entry — as opposed to rel="self"
// / rel="edit" API links we don't want.
function atomAlternateHref(block) {
  const links = matchAll(block, /<link\b[^>]*>/gi);
  let fallback = "";
  for (const tag of links) {
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    const rel = (tag.match(/\brel\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!rel || rel.toLowerCase() === "alternate") return decodeXml(href).trim();
    if (!fallback) fallback = decodeXml(href).trim();
  }
  return fallback;
}

function unwrapCdata(s) {
  if (typeof s !== "string") return "";
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : s;
}

// Strips markup from a summary/description via content-fetch's htmlToText, then
// collapses whitespace. Feed descriptions are often HTML fragments.
function stripHtml(s) {
  if (typeof s !== "string" || s.length === 0) return "";
  if (/<[a-z][\s\S]*>/i.test(s)) return htmlToText(s);
  return s.replace(/\s+/g, " ").trim();
}

function decodeXml(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&#x27;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&amp;/gi, "&");
}

function safeCodePoint(cp) {
  try {
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
  } catch {
    return "";
  }
}

// Normalizes a feed date (RFC 822 pubDate or ISO 8601) to an ISO string, or
// null when it doesn't parse — so downstream sorting and display get one shape.
function normalizeDate(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

function clip(s, max) {
  if (typeof s !== "string") return "";
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

function matchAll(haystack, regex) {
  return haystack.match(regex) ?? [];
}

function matchFirst(haystack, regex) {
  const m = haystack.match(regex);
  return m ? m[0] : null;
}
