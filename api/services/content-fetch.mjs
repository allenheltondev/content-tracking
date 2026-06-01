import { logger } from "./logger.mjs";

// Best-effort fetch of a content post's body text so the recommendation
// agent can reason over what the piece actually says, not just its URL and
// notes. Blog posts overwhelmingly live on static sites, so a plain GET
// returns server-rendered HTML we can strip to text.
//
// This is deliberately non-fatal: a paywall, a bot block, a JS-only render,
// or a timeout just means the agent works from the metadata it already has.
// Callers get null on any failure rather than an exception — the
// recommendation must still generate.

// Generous enough for a long blog post, bounded so a runaway page (or an
// accidental file download) can't blow up token usage.
const MAX_CONTENT_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 8_000;

// A real-ish User-Agent: some static hosts/CDNs return 403 to the default
// undici agent string. We're fetching a URL the user told us they published,
// so identifying as a normal client is appropriate.
const USER_AGENT =
  "Mozilla/5.0 (compatible; BookedContentBot/1.0; +https://readysetcloud.io)";

export async function fetchContentText(url) {
  // The URL is user-supplied (stored on the content post), so this GET is an
  // SSRF vector. Skip anything that isn't a public http(s) target before we
  // make the request. Not bulletproof against DNS rebinding, but it blocks
  // the obvious internal/metadata targets.
  if (!isPublicHttpUrl(url)) {
    logger.warn("Content fetch skipped for non-public URL", { url });
    return null;
  }

  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
    });
  } catch (err) {
    logger.warn("Content fetch failed; proceeding without body text", {
      url,
      error: err?.message,
    });
    return null;
  }

  if (!response.ok) {
    logger.warn("Content fetch non-OK; proceeding without body text", {
      url,
      status: response.status,
    });
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
    logger.warn("Content fetch returned non-text content; skipping body text", {
      url,
      contentType,
    });
    return null;
  }

  let body;
  try {
    body = await response.text();
  } catch (err) {
    logger.warn("Reading content body failed; proceeding without body text", {
      url,
      error: err?.message,
    });
    return null;
  }

  const text = htmlToText(body);
  if (text.length === 0) {
    logger.warn("Content fetch yielded no extractable text", { url });
    return null;
  }

  return text.length > MAX_CONTENT_CHARS ? text.slice(0, MAX_CONTENT_CHARS) : text;
}

// Lightweight HTML-to-text extraction. No DOM parser dependency — a few
// targeted passes get the article body close enough for the model to grasp
// what the piece is about, which is all the recommendation needs.
export function htmlToText(html) {
  if (typeof html !== "string" || html.length === 0) return "";

  // Strip the parts that never carry article prose, including their content.
  let working = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ");

  // Prefer the semantic article/main region when present — it drops nav,
  // sidebars, and footers that would otherwise dilute the text.
  const region =
    matchFirst(working, /<article[\s\S]*?<\/article>/i) ??
    matchFirst(working, /<main[\s\S]*?<\/main>/i) ??
    matchFirst(working, /<body[\s\S]*?<\/body>/i) ??
    working;

  const text = region
    // Turn block-level boundaries into newlines so words don't run together.
    .replace(/<\/(p|div|section|article|header|footer|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Drop every remaining tag.
    .replace(/<[^>]+>/g, " ")
    // Decode the handful of entities that actually show up in prose.
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&#x27;/gi, "'")
    // Collapse whitespace: many spaces/tabs to one, 3+ newlines to two.
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

function matchFirst(haystack, regex) {
  const m = haystack.match(regex);
  return m ? m[0] : null;
}

// True only for http(s) URLs whose host isn't an obvious internal target.
// Rejects localhost, *.local, the cloud metadata hostname, and private /
// loopback / link-local IP literals (v4 and a few v6 forms).
export function isPublicHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  // Strip IPv6 brackets for inspection.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return false;
  }
  if (host === "metadata.google.internal") return false;

  // IPv4 literal in a private / loopback / link-local / unspecified range.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false; // link-local incl. 169.254.169.254
  }

  // IPv6 loopback / unspecified / link-local (fe80::) / unique-local (fc00::/7).
  if (host === "::1" || host === "::") return false;
  if (/^fe80:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host)) return false;

  return true;
}
