#!/usr/bin/env node
//
// ============================================================================
// HANDOFF BRIEF — read this before touching the code below.
// ============================================================================
//
// GOAL
//   One-time import of an EXISTING markdown blog catalog (kept in a SEPARATE
//   git repo) into this project's DynamoDB table as `Blog` items. Once a Blog
//   row exists, the rest is automatic:
//     • the DynamoDB stream → VectorizeBlogFunction embeds it into the
//       `blog-vectors` S3 Vectors index (powers POST /blogs/ask), and
//     • scripts/seed-voice-from-blogs.mjs turns the catalog into the "blog"
//       voice profile (powers POST /voice/compose).
//   So this script's ONLY job is to write correct `Blog` items. Don't
//   re-implement vectorization or voice here.
//
// DECISIONS ALREADY MADE BY THE OWNER (do not re-litigate)
//   • One-time backfill (not an ongoing sync).
//   • Direct DynamoDB write (NOT POST /blogs) so we can PRESERVE each post's
//     original publish date. Going through the API would stamp createdAt = now
//     and lose catalog ordering.
//
// WHAT IS ALREADY CORRECT BELOW (don't change without reason)
//   • The Blog item shape in buildItem() mirrors api/domain/blog.mjs createBlog()
//     EXACTLY — same keys, same GSI1 keys (gsi1pk = TENANT#{sub}#BLOG,
//     gsi1sk = `${createdAt}#${blogId}`), same links/ids seeding. Keep it in
//     sync with that file if the model ever changes.
//   • Idempotency: blogId is DERIVED FROM THE SLUG (not a random ULID), so
//     re-running overwrites the same item (sk = BLOG#{slug}) instead of
//     duplicating. This also keeps vector keys (`${blogId}#${chunk}`) and the
//     voice-seed id (`BLOG-${blogId}`) stable across re-imports.
//   • Dry-run by default; --apply to write. Mirrors backfill-blog-vectors.mjs.
//
// >>> THE ONE THING YOU MUST VERIFY: the frontmatter → Blog field mapping. <<<
//   mapToBlog() below uses common conventions (Hugo/Jekyll/Astro/Next) with
//   alias fallbacks, but it is a GUESS until you look at the real repo. Open a
//   few actual posts and confirm/adjust:
//     - which frontmatter key holds the title, slug, description, tags, date,
//       canonical URL (see the alias lists in mapToBlog);
//     - the DATE format (ISO? "2024-01-02"? a Date object? Unix?) → it must end
//       up as an ISO-8601 string in createdAt;
//     - whether the slug comes from frontmatter or must be derived from the
//       filename/path;
//     - whether drafts are flagged (frontmatter `draft: true` / `published:
//       false`) so they can be skipped.
//
// CONSTRAINTS TO RESPECT (we bypass the API, so enforce these ourselves —
// see api/validation/blog.mjs for the source of truth)
//   • slug MUST be kebab-case: /^[a-z0-9]+(?:-[a-z0-9]+)*$/  (slugify() handles
//     it; blogId == slug, so a bad slug = a bad key).
//   • title and contentMarkdown must be non-empty.
//   • contentMarkdown is capped at 300_000 chars (DynamoDB 400KB item limit).
//     Truncate or skip giant posts and LOG it — don't silently drop content.
//   • description ≤ 1000, each tag ≤ 50, ≤ 30 tags, canonical_url must be http(s).
//
// INPUTS THE OWNER PROVIDES AT RUN TIME
//   --repo    path to a LOCAL CHECKOUT of the blog repo (clone it first).
//   --tenant  the Cognito `sub` the blogs belong to (the DynamoDB partition
//             key, TENANT#{sub}). If this is wrong, the blogs import "successfully"
//             but never show up for the user. Get it from the dashboard session
//             or the Cognito user pool. THERE IS NO SAFE DEFAULT — require it.
//   --table   DynamoDB table name (e.g. content-tracking).
//   --region  AWS region (default us-east-1). AWS creds come from the env/profile,
//             same as the other scripts (AWS_PROFILE=... node scripts/...).
//   --glob    optional file match override (default **/*.md and **/*.mdx).
//   --apply   actually write. Omit for a dry-run that prints what it would do.
//
// MDX NOTE: .mdx bodies may contain JSX/import lines. They embed fine (just
//   noisier signal). Decide whether to strip import/export lines in mapToBlog;
//   left as-is by default.
//
// COST / ORDER-OF-OPERATIONS HEADS-UP for whoever RUNS this
//   • Each Blog PutItem fires the stream → one Titan embedding pass per post
//     (Bedrock spend scales with catalog size). For a large catalog consider
//     importing in waves and watching VectorizeBlogDLQ.
//   • If the stack's stream consumer ISN'T deployed yet, run
//     scripts/backfill-blog-vectors.mjs --apply AFTER this to vectorize.
//   • For the blog voice profile, run scripts/seed-voice-from-blogs.mjs --apply
//     AFTER this (it reads the Blog rows this script writes).
//
// DEPENDENCY: this uses `gray-matter` to parse frontmatter. It is NOT yet a
//   project dependency — add it before running:  npm i -D gray-matter
//   (or swap in your own frontmatter parser in readPost()).
// ============================================================================

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import matter from "gray-matter"; // npm i -D gray-matter

const args = parseArgs(process.argv.slice(2));
if (!args.repo || !args.table || !args.tenant) {
  console.error(
    "Usage: import-blogs.mjs --repo <path> --table <name> --tenant <cognito-sub> [--apply] [--region us-east-1] [--glob '**/*.md']",
  );
  process.exit(1);
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region }), {
  marshallOptions: { removeUndefinedValues: true },
});

const CONTENT_MAX = 300_000;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

let found = 0;
let imported = 0;
let skipped = 0;

for (const file of await listMarkdownFiles(args.repo)) {
  found += 1;
  const post = await readPost(file);
  const blog = mapToBlog(post.data, post.content, file);

  if (blog.skip) {
    skipped += 1;
    console.log(`skip ${path.relative(args.repo, file)} (${blog.skipReason})`);
    continue;
  }

  if (!args.apply) {
    console.log(`[dry-run] ${blog.slug}  "${blog.title}"  (${blog.createdAt})`);
    continue;
  }

  await ddb.send(new PutCommand({ TableName: args.table, Item: buildItem(blog) }));
  imported += 1;
  console.log(`imported ${blog.slug}`);
}

console.log("---");
console.log(`Files found: ${found}`);
console.log(`Skipped: ${skipped}`);
console.log(args.apply ? `Imported: ${imported}` : "(dry-run; pass --apply to write)");
if (args.apply) {
  console.log("Next: blogs auto-vectorize via the stream; run seed-voice-from-blogs.mjs --apply for the voice profile.");
}

// ----------------------------------------------------------------------------
// VERIFY THIS against the real repo — frontmatter key names + date format.
// Returns { skip, skipReason } OR a normalized blog object.
// ----------------------------------------------------------------------------
function mapToBlog(data, content, file) {
  data = data ?? {};

  // Drafts: skip anything explicitly unpublished.
  if (data.draft === true || data.published === false) {
    return { skip: true, skipReason: "draft" };
  }

  const title = firstString(data.title) ?? titleFromFilename(file);
  const rawSlug = firstString(data.slug) ?? path.basename(file).replace(/\.(md|mdx)$/i, "");
  const slug = slugify(rawSlug);

  const contentMarkdown = (content ?? "").trim();
  if (!title || !contentMarkdown) return { skip: true, skipReason: "missing title/body" };
  if (!SLUG_RE.test(slug)) return { skip: true, skipReason: `unslugifiable: ${rawSlug}` };

  const dateRaw = data.date ?? data.publishDate ?? data.pubDate ?? data.published ?? data.created;
  const createdAt = toIso(dateRaw) ?? toIso(undefined); // fall back to now; consider file mtime instead

  return {
    skip: false,
    title,
    slug,
    contentMarkdown: contentMarkdown.length > CONTENT_MAX
      ? logTrim(slug, contentMarkdown)
      : contentMarkdown,
    description: clamp(firstString(data.description ?? data.summary ?? data.excerpt), 1000),
    tags: toStringArray(data.tags).slice(0, 30).map((t) => t.slice(0, 50)),
    categories: toStringArray(data.categories),
    canonicalUrl: httpOrNull(firstString(data.canonicalUrl ?? data.canonical ?? data.canonical_url)),
    createdAt,
  };
}

// Blog item shape — MIRRORS api/domain/blog.mjs createBlog(). Keep in sync.
function buildItem(blog) {
  const now = new Date().toISOString();
  const blogId = blog.slug; // deterministic id → idempotent re-import
  return {
    pk: `TENANT#${args.tenant}`,
    sk: `BLOG#${blogId}`,
    entity: "Blog",
    tenantId: args.tenant,
    blogId,
    title: blog.title,
    slug: blog.slug,
    contentMarkdown: blog.contentMarkdown,
    description: blog.description ?? null,
    tags: blog.tags ?? [],
    categories: blog.categories ?? [],
    canonicalUrl: blog.canonicalUrl ?? null,
    // parse-blog's cross-link rewriting matches against links.url (see createBlog).
    links: { url: blog.canonicalUrl ?? null },
    ids: {},
    gsi1pk: `TENANT#${args.tenant}#BLOG`,
    gsi1sk: `${blog.createdAt}#${blogId}`,
    createdAt: blog.createdAt,
    updatedAt: now,
  };
}

async function readPost(file) {
  const raw = await readFile(file, "utf8");
  // gray-matter handles YAML/TOML/JSON frontmatter. Swap if your repo differs.
  return matter(raw);
}

// Recursive walk; skips node_modules/.git/dist and matches .md/.mdx (or --glob
// extension if you tighten it). Replace with fs.glob (Node 22+) if you prefer.
async function listMarkdownFiles(root) {
  const out = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist", ".next", "build"].includes(entry.name)) continue;
        await walk(full);
      } else if (/\.(md|mdx)$/i.test(entry.name)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

// ---- small helpers -------------------------------------------------------
function firstString(v) {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function toStringArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  return firstString(v) ? [firstString(v)] : [];
}
function clamp(s, max) {
  return s ? s.slice(0, max) : null;
}
function httpOrNull(s) {
  return s && /^https?:\/\//i.test(s) ? s : null;
}
function toIso(v) {
  if (v === undefined || v === null) return new Date().toISOString();
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function slugify(s) {
  return String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function titleFromFilename(file) {
  return path.basename(file).replace(/\.(md|mdx)$/i, "").replace(/[-_]+/g, " ").trim();
}
function logTrim(slug, content) {
  console.warn(`TRIM ${slug}: content ${content.length} > ${CONTENT_MAX} chars; truncating`);
  return content.slice(0, CONTENT_MAX);
}

function parseArgs(argv) {
  const out = { region: "us-east-1", apply: false, glob: "**/*.{md,mdx}" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--table") out.table = argv[++i];
    else if (a === "--tenant") out.tenant = argv[++i];
    else if (a === "--region") out.region = argv[++i];
    else if (a === "--glob") out.glob = argv[++i];
  }
  return out;
}
