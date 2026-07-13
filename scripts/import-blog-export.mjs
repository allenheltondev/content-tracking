#!/usr/bin/env node
//
// Bulk import of a blog data export into the unified Content catalog.
//
// The export is an index of posts — slug, title, canonicalUrl, publishedAt,
// per-platform crosspost URLs/ids, and as-of view totals — plus (added for
// this import) a `fileLocation` per post pointing at the on-disk Markdown file
// (frontmatter + body). This script joins the two, transforms each post, and
// writes it into DynamoDB the same way the API would, so the downstream
// stream-driven pipelines fire on their own:
//
//   Content root  (PutItem) -> table stream -> VectorizeContentFunction
//                                            -> VoiceMemoryFunction (auto-capture
//                                               of published blog posts)
//   ContentPublish rows      -> per-platform crosspost URLs/ids
//   ContentStats rows        -> per-platform view snapshot (as of exportedAt)
//
// We write directly to DynamoDB (not the HTTP API) for the same reasons the
// other operator scripts do (migrate-blogs-to-content.mjs, backfill-*): the
// vectorize + voice pipelines are stream-driven, so a direct Put on the Content
// root triggers them exactly like an API POST; a direct write lets us use a
// DETERMINISTIC contentId so re-runs are idempotent (the API mints a random
// ULID, which would duplicate every post on every re-run); and it needs only
// AWS credentials rather than a minted Cognito JWT.
//
// ADDITIVE + IDEMPOTENT. Everything is a deterministic overwrite keyed on the
// content's derived id, so re-running rewrites the same rows in place. Because
// the item is byte-for-byte identical on a re-run (timestamps are derived from
// publishedAt/exportedAt, never "now"), the stream sees an unchanged NewImage
// and the vectorizer's content-hash guard makes it a no-op.
//
// Usage:
//   AWS_PROFILE=staging node scripts/import-blog-export.mjs \
//     --file export.json --tenant <cognito-sub> --table content-tracking
//   AWS_PROFILE=staging node scripts/import-blog-export.mjs \
//     --file export.json --tenant <cognito-sub> --table content-tracking --apply
//
// Without --apply the script runs in dry-run mode (the default): it prints what
// WOULD be written but writes nothing. Run twice — once to confirm the counts,
// then again with --apply.
//
//   --file      path to the JSON export (required)
//   --tenant    Cognito sub to store the content under (required). The export's
//               own tenantId string is ignored; content lands in TENANT#{sub}.
//   --table     DynamoDB single-table name (required)
//   --region    AWS region (default us-east-1)
//   --base-dir  base directory to resolve a relative `fileLocation` against
//               (default: the directory containing the export file)
//   --apply     perform the writes (default is dry-run)
//   --help      show this help

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";

import { validateContentCreate } from "../api/validation/content.mjs";
import {
  validatePublishVariant,
  validateStatsUpdate,
} from "../api/validation/content-analytics.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.file || !args.tenant || !args.table) {
  const missing = args.help
    ? ""
    : `\nMissing required: ${["file", "tenant", "table"].filter((k) => !args[k]).map((k) => `--${k}`).join(", ")}\n`;
  console.error(
    "Usage: import-blog-export.mjs --file <export.json> --tenant <cognito-sub> --table <name> [--apply]\n" +
      "\n" +
      "  --file      path to the JSON export (required)\n" +
      "  --tenant    Cognito sub to store the content under (required)\n" +
      "  --table     DynamoDB single-table name (required)\n" +
      "  --region    AWS region (default us-east-1)\n" +
      "  --base-dir  base dir for relative fileLocation (default: export file's dir)\n" +
      "  --apply     perform the writes (default is dry-run)\n" +
      "  --help      show this help" +
      missing,
  );
  process.exit(args.help ? 0 : 1);
}

// The shared DynamoDB client reads TABLE_NAME and its region from env at import
// time, so set both BEFORE the dynamic import below (mirrors
// migrate-blogs-to-content.mjs). An explicit --region wins over an existing
// AWS_REGION, which wins over the default.
process.env.TABLE_NAME = args.table;
process.env.AWS_REGION = args.region ?? process.env.AWS_REGION ?? "us-east-1";

const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
const { ddb, TABLE_NAME } = await import("../api/services/ddb.mjs");
// Import the real key builders so this script can never drift from the storage
// key shapes the domain (and therefore the running app) uses.
const { contentKey, publishVariantKey, statsKey } = await import("../api/domain/content.mjs");

const TENANT_ID = args.tenant;
const BASE_DIR = args.baseDir ?? dirname(resolve(args.file));

// The platforms the export models a crosspost for. Order is stable so links/ids
// maps and the dry-run output read consistently.
const CROSSPOST_PLATFORMS = ["dev", "medium", "hashnode"];

// ---------------------------------------------------------------------
// Deterministic content id.
//
// A ULID-shaped (26-char Crockford base32) id derived from tenantId + slug.
// Deterministic so re-runs overwrite in place rather than duplicate; fixed
// length so it is safe against deleteContent's begins_with(sk, "CONTENT#{id}")
// cascade (a raw slug could be a prefix of another slug — e.g. "foo" of
// "foo-part-2" — and delete the wrong post's children).
// ---------------------------------------------------------------------
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function deterministicContentId(tenantId, slug) {
  const digest = createHash("sha256").update(`${tenantId}\n${slug}`).digest();
  let n = 0n;
  for (let i = 0; i < 16; i++) n = (n << 8n) | BigInt(digest[i]);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

// ---------------------------------------------------------------------
// Frontmatter parsing.
//
// The blog files are Hugo-style: a fenced frontmatter block (YAML `---` or, as
// a fallback, TOML `+++`) followed by the Markdown body. No YAML library is
// bundled, so this parses the small subset frontmatter actually uses: scalar
// key/value pairs, single/double-quoted strings, inline arrays (`[a, b]`), and
// block arrays (`  - item`). Unrecognized lines are ignored. Only the fields we
// consume are read downstream; anything else is carried in the returned object
// harmlessly.
// ---------------------------------------------------------------------
export function splitFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, ""); // strip BOM
  const yaml = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (yaml) {
    return { frontmatter: parseYamlSubset(yaml[1], "yaml"), body: text.slice(yaml[0].length) };
  }
  const toml = text.match(/^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+\r?\n?/);
  if (toml) {
    return { frontmatter: parseYamlSubset(toml[1], "toml"), body: text.slice(toml[0].length) };
  }
  // No frontmatter fence: the whole file is the body.
  return { frontmatter: {}, body: text };
}

function parseYamlSubset(block, dialect) {
  // TOML uses `key = value`; YAML uses `key: value`. Everything else in the
  // subset we handle is shared.
  const kvSep = dialect === "toml" ? /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/ : /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;
  const out = {};
  let lastKey = null;
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const arr = line.match(/^\s*-\s+(.*)$/);
    if (arr && lastKey && dialect === "yaml") {
      if (!Array.isArray(out[lastKey])) out[lastKey] = [];
      out[lastKey].push(parseScalar(arr[1]));
      continue;
    }

    const kv = line.match(kvSep);
    if (!kv) {
      lastKey = null;
      continue;
    }
    lastKey = kv[1];
    const rhs = kv[2].trim();

    // YAML block scalars: `key: |` (literal) or `key: >` (folded), each with an
    // optional chomping indicator (`-`/`+`). Without this the indicator itself
    // (">-", "|", ...) leaks in as the value and the indented body below is
    // dropped — which is exactly how ">- " ended up as post descriptions.
    const scalar = dialect === "yaml" && rhs.match(/^([|>])([+-]?)$/);
    if (scalar) {
      const keyIndent = line.match(/^(\s*)/)[1].length;
      const bodyLines = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === "") { bodyLines.push(""); continue; }
        if (l.match(/^(\s*)/)[1].length <= keyIndent) break;
        bodyLines.push(l);
      }
      i = j - 1; // resume after the block body
      out[lastKey] = foldBlockScalar(bodyLines, { folded: scalar[1] === ">" });
      continue;
    }

    out[lastKey] = rhs === "" ? "" : parseValue(rhs);
  }
  return out;
}

// Joins the collected lines of a YAML block scalar after stripping the common
// leading indentation. Folded (`>`) style collapses line breaks within a
// paragraph to spaces; literal (`|`) style keeps them. Blank lines mark
// paragraph breaks in both. Trailing/leading whitespace is trimmed, which
// covers the chomping styles we care about for short frontmatter fields.
function foldBlockScalar(bodyLines, { folded }) {
  const indents = bodyLines.filter((l) => l.trim()).map((l) => l.match(/^(\s*)/)[1].length);
  const base = indents.length ? Math.min(...indents) : 0;
  const body = bodyLines.map((l) => (l.trim() ? l.slice(base) : ""));

  if (!folded) return body.join("\n").trim();

  let text = "";
  for (const cur of body) {
    if (cur === "") { text += "\n"; continue; }
    if (text && !text.endsWith("\n")) text += " ";
    text += cur;
  }
  return text.trim();
}

function parseValue(v) {
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner ? splitInline(inner).map(parseScalar) : [];
  }
  return parseScalar(v);
}

function parseScalar(s) {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // Strip a trailing inline comment on a bare (unquoted) scalar.
  const c = s.indexOf(" #");
  if (c >= 0) s = s.slice(0, c).trim();
  return s;
}

// Comma-split that respects quotes, so `["a, b", c]` yields two items.
function splitInline(inner) {
  const parts = [];
  let cur = "";
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// ---------------------------------------------------------------------
// Date normalization. publishedAt is sometimes a bare date ("2022-12-28") and
// sometimes a full ISO timestamp; the Content calendar wants a YYYY-MM-DD
// publishDate, while createdAt/gsi1sk want a full ISO instant.
// ---------------------------------------------------------------------
function toIsoInstant(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toIsoDate(value) {
  const instant = toIsoInstant(value);
  return instant ? instant.slice(0, 10) : null;
}

// ---------------------------------------------------------------------
// Crosspost reality test. A crosspost entry only represents a real off-platform
// post when it has an external id, or its URL is on a different host than the
// canonical (some entries just echo the canonical URL with a null id — those
// were never actually crossposted).
// ---------------------------------------------------------------------
function canonicalHostOf(canonicalUrl) {
  try {
    return new URL(canonicalUrl).host;
  } catch {
    return null;
  }
}

export function isRealCrosspost(entry, canonicalHost) {
  if (!entry || !entry.url) return false;
  if (entry.id !== null && entry.id !== undefined) return true;
  let host;
  try {
    host = new URL(entry.url).host;
  } catch {
    return false;
  }
  return Boolean(host) && host !== canonicalHost;
}

// ---------------------------------------------------------------------
// Pure transforms: one export blog (+ its file) -> DynamoDB items.
// ---------------------------------------------------------------------

// Builds the Content root item. Runs the export/frontmatter fields through the
// API's own validateContentCreate so the import is held to the same rules as a
// POST /content, then assembles the exact storage shape createContent produces
// (deterministic id, seeded links/ids, GSI1 keys, timestamps derived from the
// post's publish date so history is preserved and re-runs stay identical).
export function buildContentItem({ blog, frontmatter, body, tenantId }) {
  const contentId = deterministicContentId(tenantId, blog.slug);
  const canonicalHost = canonicalHostOf(blog.canonicalUrl);

  const publishDate = blog.publishedAt ? toIsoDate(blog.publishedAt) : null;
  const createdAt = (blog.publishedAt && toIsoInstant(blog.publishedAt)) || `${publishDate ?? "1970-01-01"}T00:00:00.000Z`;

  // snake_case request-shaped body, validated exactly like the API would.
  const requestBody = {
    title: blog.title ?? frontmatter.title,
    type: "blog",
    slug: blog.slug,
    content_markdown: body,
    source: "owned",
    status: "published", // live catalog posts; also what makes them voice-eligible
  };
  if (frontmatter.description) requestBody.description = String(frontmatter.description);
  if (blog.canonicalUrl) requestBody.canonical_url = blog.canonicalUrl;
  const tags = normalizeStringArray(frontmatter.tags);
  const categories = normalizeStringArray(frontmatter.categories);
  if (tags.length) requestBody.tags = tags;
  if (categories.length) requestBody.categories = categories;
  if (publishDate) requestBody.publish_date = publishDate;

  const fields = validateContentCreate(requestBody); // throws BadRequestError on any violation

  // Seed links.url with the canonical URL and mirror each real crosspost's copy
  // URL/id, matching what the publish flow and cross-link rewriter expect.
  const links = { url: blog.canonicalUrl };
  const ids = {};
  for (const platform of CROSSPOST_PLATFORMS) {
    const entry = blog.crossposts?.[platform];
    if (isRealCrosspost(entry, canonicalHost)) {
      links[platform] = entry.url;
      if (entry.id !== null && entry.id !== undefined) ids[platform] = entry.id;
    }
  }

  const item = {
    ...fields,
    ...contentKey(tenantId, contentId),
    entity: "Content",
    tenantId,
    contentId,
    links,
    ids,
    gsi1pk: `TENANT#${tenantId}#CONTENT`,
    gsi1sk: `${createdAt}#${contentId}`,
    createdAt,
    updatedAt: createdAt,
  };

  // image / imageAttribution aren't part of validateContentCreate's schema but
  // are carried on the entity (the Medium cross-post header uses them), so mirror
  // them straight from frontmatter when present.
  if (frontmatter.image) item.image = String(frontmatter.image);
  const attribution = frontmatter.imageAttribution ?? frontmatter.image_attribution;
  if (attribution) item.imageAttribution = String(attribution);

  return { contentId, item };
}

// Builds a ContentPublish row per real crosspost. Validates the core fields with
// the API's validatePublishVariant, then carries the external id + recorded
// status the same way migrate-blogs-to-content.mjs does.
export function buildPublishItems({ blog, tenantId, contentId }) {
  const canonicalHost = canonicalHostOf(blog.canonicalUrl);
  const publishedAt = blog.publishedAt ? toIsoInstant(blog.publishedAt) : null;
  const items = [];

  for (const platform of CROSSPOST_PLATFORMS) {
    const entry = blog.crossposts?.[platform];
    if (!isRealCrosspost(entry, canonicalHost)) continue;

    const core = validatePublishVariant({
      platform,
      url: entry.url,
      ...(publishedAt ? { published_at: publishedAt } : {}),
    });

    const status = entry.status ?? blog.publish?.[platform]?.status ?? "succeeded";
    const item = {
      ...publishVariantKey(tenantId, contentId, platform),
      entity: "ContentPublish",
      tenantId,
      contentId,
      platform: core.platform,
      status,
      url: core.url,
      updatedAt: publishedAt ?? blog.publishedAt ?? null,
    };
    if (entry.id !== null && entry.id !== undefined) item.id = entry.id;
    if (core.publishedAt) item.publishedAt = core.publishedAt;

    items.push(item);
  }

  return items;
}

// Builds a ContentStats snapshot per platform from analytics.totals, dated at
// the export instant (these totals are "as of exportedAt"). `total` is derived
// and skipped. Validated with the API's validateStatsUpdate.
export function buildStatsItems({ blog, tenantId, contentId, exportedAt }) {
  const totals = blog.analytics?.totals ?? {};
  const capturedAt = toIsoInstant(exportedAt) ?? new Date().toISOString();
  const date = capturedAt.slice(0, 10);
  const items = [];

  for (const [platform, views] of Object.entries(totals)) {
    if (platform === "total") continue;
    if (typeof views !== "number" || !Number.isFinite(views) || views < 0) continue;

    // Reuse the API's stats validator for parity, then key + stamp the row the
    // way putStatsSnapshot does.
    validateStatsUpdate({ metrics: { views }, captured_at: capturedAt });
    items.push({
      ...statsKey(tenantId, contentId, platform, date),
      entity: "ContentStats",
      tenantId,
      contentId,
      platform,
      date,
      metrics: { views },
      capturedAt,
    });
  }

  return items;
}

function normalizeStringArray(value) {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((v) => (typeof v === "string" ? v.trim() : String(v).trim()))
    .filter((v) => v.length > 0);
}

// ---------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------

const exportDoc = JSON.parse(readFileSync(resolve(args.file), "utf8"));
const blogs = Array.isArray(exportDoc.blogs) ? exportDoc.blogs : [];
const exportedAt = exportDoc.exportedAt;

if (blogs.length === 0) {
  console.error("No blogs found in the export (expected a top-level `blogs` array).");
  process.exit(1);
}

// A single --tenant maps every post; warn if the export mixes tenants so the
// operator knows they're all being folded under one sub.
const exportTenants = new Set(blogs.map((b) => b.tenantId).filter(Boolean));
if (exportTenants.size > 1) {
  console.warn(
    `Export contains ${exportTenants.size} distinct tenantIds (${[...exportTenants].join(", ")}); ` +
      `all are being imported under --tenant ${TENANT_ID}.`,
  );
}

let contentRows = 0;
let publishRows = 0;
let statsRows = 0;
let skipped = 0;
const samples = [];

for (const blog of blogs) {
  if (!blog.slug) {
    console.warn(`Skipping blog with no slug: "${blog.title ?? "(untitled)"}"`);
    skipped += 1;
    continue;
  }

  let body;
  let frontmatter;
  try {
    if (!blog.fileLocation) throw new Error("missing fileLocation");
    const filePath = isAbsolute(blog.fileLocation) ? blog.fileLocation : resolve(BASE_DIR, blog.fileLocation);
    const raw = readFileSync(filePath, "utf8");
    ({ frontmatter, body } = splitFrontmatter(raw));
  } catch (err) {
    console.warn(`Skipping "${blog.slug}": cannot read body — ${err.message}`);
    skipped += 1;
    continue;
  }

  let contentId;
  let contentItem;
  let publishItems;
  let statsItems;
  try {
    ({ contentId, item: contentItem } = buildContentItem({ blog, frontmatter, body, tenantId: TENANT_ID }));
    publishItems = buildPublishItems({ blog, tenantId: TENANT_ID, contentId });
    statsItems = buildStatsItems({ blog, tenantId: TENANT_ID, contentId, exportedAt });
  } catch (err) {
    // BadRequestError from a validator (e.g. a non-kebab slug or empty body).
    console.warn(`Skipping "${blog.slug}": ${err.message}`);
    skipped += 1;
    continue;
  }

  if (samples.length < 3) {
    samples.push({ contentItem, publishItems, statsItems });
  }

  if (!args.apply) {
    console.log(
      `[dry-run] ${blog.slug} -> Content ${contentId} ` +
        `(+${publishItems.length} publish, +${statsItems.length} stats) — "${contentItem.title}"`,
    );
    contentRows += 1;
    publishRows += publishItems.length;
    statsRows += statsItems.length;
    continue;
  }

  // Root first so the stream fires the vectorize + voice pipelines; children
  // (filtered out of both streams) after.
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: contentItem }));
  contentRows += 1;
  console.log(`Wrote Content ${contentId} — "${contentItem.title}"`);

  for (const item of publishItems) {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
    publishRows += 1;
    console.log(`  publish ${item.platform} -> ${item.url}`);
  }
  for (const item of statsItems) {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
    statsRows += 1;
    console.log(`  stats ${item.platform} -> ${item.metrics.views} views`);
  }
}

if (samples.length > 0) {
  console.log("---");
  console.log("Sample transform(s):");
  console.log(JSON.stringify(samples, null, 2));
}

console.log("---");
console.log(`Tenant:             ${TENANT_ID}`);
console.log(`Blogs in export:    ${blogs.length}`);
console.log(`Content rows:       ${contentRows}`);
console.log(`Publish rows:       ${publishRows}`);
console.log(`Stats rows:         ${statsRows}`);
console.log(`Skipped:            ${skipped}`);
if (!args.apply) {
  console.log("(dry-run; use --apply to write)");
}

function parseArgs(argv) {
  const out = { apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--file") out.file = argv[++i];
    else if (arg === "--tenant") out.tenant = argv[++i];
    else if (arg === "--table") out.table = argv[++i];
    else if (arg === "--region") out.region = argv[++i];
    else if (arg === "--base-dir") out.baseDir = argv[++i];
  }
  return out;
}
