// The HTML template is inlined into the bundle as a string by esbuild's
// `.html=text` loader (see template.yaml esbuild-properties). It contains a
// single __MEDIA_KIT_DATA__ token inside a <script type="application/json">
// tag; we swap that token for the snapshot's JSON so the resulting page is
// fully self-contained (no runtime API calls; the only external resources
// are the avatar/logo image URLs baked into the data).
//
// The page body is built client-side from that JSON. Crawlers and link
// unfurlers (Google, Slack, X, LinkedIn) generally do NOT run that script,
// so all SEO — title, description, canonical, Open Graph / Twitter cards,
// and JSON-LD — is server-rendered into <head> here, at the
// __MEDIA_KIT_HEAD__ comment token. Only the public teaser gets it; private
// signed kits stay noindex with an empty head block.
import TEMPLATE from "../templates/media-kit.html";

const TOKEN = "__MEDIA_KIT_DATA__";
const HEAD_TOKEN = "<!--__MEDIA_KIT_HEAD__-->";

// Line/paragraph separators are valid in JSON but illegal raw inside a JS
// string literal in some parsers, so they are escaped too. Built with RegExp
// constructors to avoid placing the raw separator characters in source.
const LINE_SEP = new RegExp(" ", "g");
const PARA_SEP = new RegExp(" ", "g");

// Escape JSON so it can never break out of the <script> tag it is embedded
// in. `<` -> escaped neutralizes any `</script>` sequence in the data; the
// matching `>` and `&` escapes keep the payload HTML-inert.
function escapeForScript(json) {
  return json
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(LINE_SEP, "\\u2028")
    .replace(PARA_SEP, "\\u2029");
}

// The template ships with a noindex directive (private signed kits must
// never be indexed). The public teaser overrides this so the bio-link page
// can be found by search engines.
const NOINDEX_META = '<meta name="robots" content="noindex, nofollow">';
const INDEX_META = '<meta name="robots" content="index, follow">';

// Escape a value for use inside a double-quoted HTML attribute.
function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Escape text content for inside an element (e.g. <title>).
function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Escape a JSON-LD payload for embedding in a <script type="application/ld+json">
// block. Only `<` needs neutralizing so the data can never open or close a
// tag; JSON.stringify already produces valid JSON otherwise.
function escapeForLdJson(json) {
  return json.replace(/</g, "\\u003c");
}

// Trim a string to maxLen on a word boundary with an ellipsis — keeps meta
// descriptions within the ~160 chars search engines display.
function truncate(value, maxLen) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// Builds the SEO description from the available profile copy, falling back
// through bio -> tagline -> a generated sentence so the page is never
// description-less.
function buildDescription(snapshot) {
  const identity = snapshot.identity ?? {};
  const name = identity.displayName || snapshot.brand?.name || "This creator";
  if (identity.bio) return truncate(identity.bio, 160);
  if (identity.tagline) return truncate(identity.tagline, 160);
  const niches = Array.isArray(identity.niches) ? identity.niches.filter(Boolean) : [];
  const niche = niches.length ? ` covering ${niches.slice(0, 3).join(", ")}` : "";
  return truncate(`Media kit for ${name}${niche}: audience, reach, and past collaborations.`, 160);
}

// JSON-LD describing the creator as a Person on a ProfilePage. Helps search
// engines build a rich result and an entity for the creator. Only fields we
// actually have are included; sameAs links to every social profile URL.
function buildJsonLd(snapshot, { pageUrl }) {
  const identity = snapshot.identity ?? {};
  const name = identity.displayName || snapshot.brand?.name || "Creator";
  const sameAs = (snapshot.socialAccounts ?? [])
    .map((a) => a?.url)
    .filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));

  const person = {
    "@type": "Person",
    name,
  };
  if (identity.tagline) person.description = identity.tagline;
  if (identity.avatarUrl) person.image = identity.avatarUrl;
  if (snapshot.brand?.websiteUrl) person.url = snapshot.brand.websiteUrl;
  if (identity.contactEmail) person.email = `mailto:${identity.contactEmail}`;
  if (identity.location) person.homeLocation = { "@type": "Place", name: identity.location };
  if (Array.isArray(identity.niches) && identity.niches.length) {
    person.knowsAbout = identity.niches;
  }
  if (sameAs.length) person.sameAs = sameAs;

  return {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    ...(pageUrl ? { url: pageUrl } : {}),
    mainEntity: person,
  };
}

// Server-renders the full SEO head block for the public teaser: title,
// description, canonical, Open Graph + Twitter cards, and JSON-LD. Returns
// an HTML string to splice in at the head token.
function buildSeoHead(snapshot, { pageUrl }) {
  const identity = snapshot.identity ?? {};
  const name = identity.displayName || snapshot.brand?.name || "Media Kit";
  const title = identity.tagline ? `${name} — ${identity.tagline}` : `${name} — Media Kit`;
  const description = buildDescription(snapshot);
  const image = identity.avatarUrl || identity.logoUrl || null;

  const tags = [
    `<title>${escapeText(title)}</title>`,
    `<meta name="description" content="${escapeAttr(description)}">`,
  ];
  if (pageUrl) tags.push(`<link rel="canonical" href="${escapeAttr(pageUrl)}">`);

  // Open Graph (Facebook, LinkedIn, Slack, Discord, ...).
  tags.push(`<meta property="og:type" content="profile">`);
  tags.push(`<meta property="og:title" content="${escapeAttr(title)}">`);
  tags.push(`<meta property="og:description" content="${escapeAttr(description)}">`);
  tags.push(`<meta property="og:site_name" content="${escapeAttr(name)}">`);
  if (pageUrl) tags.push(`<meta property="og:url" content="${escapeAttr(pageUrl)}">`);
  if (image) tags.push(`<meta property="og:image" content="${escapeAttr(image)}">`);

  // Twitter / X card. summary_large_image when we have artwork, else summary.
  tags.push(
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
  );
  tags.push(`<meta name="twitter:title" content="${escapeAttr(title)}">`);
  tags.push(`<meta name="twitter:description" content="${escapeAttr(description)}">`);
  if (image) tags.push(`<meta name="twitter:image" content="${escapeAttr(image)}">`);
  const twitterHandle = (snapshot.socialAccounts ?? []).find(
    (a) => /^(x|twitter)$/i.test(a?.platform ?? "") && a?.handle,
  )?.handle;
  if (twitterHandle) {
    const at = twitterHandle.startsWith("@") ? twitterHandle : `@${twitterHandle}`;
    tags.push(`<meta name="twitter:creator" content="${escapeAttr(at)}">`);
  }

  const jsonLd = escapeForLdJson(JSON.stringify(buildJsonLd(snapshot, { pageUrl })));
  tags.push(`<script type="application/ld+json">${jsonLd}</script>`);

  // Update document.title too via the data — but the static <title> above is
  // what crawlers read. Newlines keep the rendered source readable.
  return tags.join("\n  ");
}

/**
 * Render a frozen media-kit snapshot into a complete, standalone HTML
 * document. Pure function: the only I/O is reading the bundled template at
 * module load. No network access.
 *
 * @param {object} snapshot - the media-kit snapshot (see data contract).
 * @param {object} [options]
 * @param {boolean} [options.indexable=false] - when true, emit an
 *   index/follow robots directive instead of the default noindex, and
 *   server-render the SEO head block (title/description/OG/Twitter/JSON-LD).
 *   Only the public teaser sets this; private signed kits stay noindex with
 *   an empty head block.
 * @param {string} [options.pageUrl] - the canonical public URL of the page,
 *   used in the canonical link and OG/Twitter/JSON-LD url fields.
 * @returns {string} the full HTML document.
 */
export function renderMediaKitHtml(snapshot, { indexable = false, pageUrl } = {}) {
  const json = JSON.stringify(snapshot);
  const safe = escapeForScript(json);
  // Use a replacer function so `$` sequences in the data are not interpreted
  // as replacement patterns by String.prototype.replace.
  let html = TEMPLATE.replace(TOKEN, () => safe);

  if (indexable) {
    html = html.replace(NOINDEX_META, INDEX_META);
    const head = buildSeoHead(snapshot, { pageUrl });
    html = html.replace(HEAD_TOKEN, () => head);
  } else {
    // Private kits ship without the SEO block — strip the token.
    html = html.replace(HEAD_TOKEN, "");
  }
  return html;
}
