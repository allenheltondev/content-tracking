#!/usr/bin/env node
//
// One-time migration: copy every existing Blog entity into the unified
// Content entity (type=blog, source=owned). This is Phase 1.4 of the
// content-model unification.
//
// ADDITIVE + IDEMPOTENT. This script NEVER deletes or mutates the original
// Blog rows. It only writes NEW Content rows (and their PUBLISH children)
// that can coexist with the Blog rows during the dual-read transition.
//
// Usage:
//   AWS_PROFILE=staging node scripts/migrate-blogs-to-content.mjs --table content-tracking
//   AWS_PROFILE=prod    node scripts/migrate-blogs-to-content.mjs --table content-tracking --apply
//
// Without `--apply` the script runs in dry-run mode (the default): it prints
// what WOULD be written but writes nothing. Run twice — once to confirm the
// counts look right, then again with --apply.
//
// Idempotency: contentId is derived deterministically as the blogId, and the
// Content root + PUBLISH children are written with a plain PutItem keyed on
// the Content sk (an overwrite). We deliberately do NOT call domain
// createContent (it guards with attribute_not_exists(sk) and would throw on
// the 2nd run) — instead we replicate its exact key/attribute shape with a
// low-level Put. Re-running is therefore safe and simply rewrites the same
// rows in place.
//
// Why a Scan: this is an operator script that must cover ALL tenants. There
// is no domain helper that lists blog roots table-wide (listBlogsByTenant is
// per-tenant via GSI1), so the lowest-risk approach is a one-shot paginated
// ScanCommand filtered on entity = "Blog" — exactly the idiom established by
// scripts/backfill-gsi1.mjs and scripts/backfill-content-vectors.mjs. A one-shot
// Scan is acceptable precisely because this runs once.

import { DynamoDBClient, paginateScan } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.table) {
  console.error(
    "Usage: migrate-blogs-to-content.mjs --table <name> [--apply] [--region us-east-1]\n" +
      "\n" +
      "  --table   DynamoDB single-table name (required)\n" +
      "  --apply   perform the writes (default is dry-run)\n" +
      "  --region  AWS region (default us-east-1)\n" +
      "  --help    show this help",
  );
  process.exit(args.help ? 0 : 1);
}

// services/ddb.mjs reads TABLE_NAME from env at import time, and the domain
// modules import it at module load, so set it BEFORE the dynamic import below.
process.env.TABLE_NAME = args.table;

const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
const { ddb, TABLE_NAME } = await import("../api/services/ddb.mjs");
const { contentKey, publishVariantKey } = await import("../api/domain/content.mjs");
const { CONTENT_STATUSES, CONTENT_TYPES, CONTENT_SOURCES } = await import("../api/validation/content.mjs");

// Fail fast if the target enums ever drift away from the constants this
// migration writes ("blog" / "owned"). Keeps the migration honest against
// validation/content.mjs.
if (!CONTENT_TYPES.includes("blog")) {
  throw new Error(`CONTENT_TYPES no longer includes "blog": ${CONTENT_TYPES.join(", ")}`);
}
if (!CONTENT_SOURCES.includes("owned")) {
  throw new Error(`CONTENT_SOURCES no longer includes "owned": ${CONTENT_SOURCES.join(", ")}`);
}

// Content fields carried over verbatim from the Blog root (camelCase storage
// names, identical in both entities). createdAt/updatedAt are preserved
// separately (NOT stamped "now") so the migrated content keeps its history.
const CARRIED_FIELDS = [
  "title",
  "slug",
  "description",
  "contentMarkdown",
  "tags",
  "categories",
  "image",
  "imageAttribution",
  "canonicalUrl",
  "campaignId",
];

// Status default: the Content status enum is
// ["draft", "scheduled", "published", "archived"]. Blog roots carry no
// lifecycle `status` field (status only ever appears on crosspost copy/run
// child rows). Existing blogs are live catalog posts, so the closest valid
// value is "published". If a blog ever does carry a status that is already a
// valid Content status, honor it; otherwise default to "published".
const DEFAULT_STATUS = "published";

// ---------------------------------------------------------------------
// Pure transform: Blog root row -> Content root item.
//
// Exported near the top so it COULD be unit-tested in isolation (there are no
// jest tests for scripts in this repo, so none is added here). Deterministic:
// contentId = blogId, createdAt/updatedAt preserved, GSI1 keys set so the row
// shows up in listContentByTenant. Mirrors the exact attribute shape that
// domain createContent produces.
// ---------------------------------------------------------------------
export function blogToContentItem(blog) {
  const tenantId = blog.tenantId;
  const contentId = blog.blogId; // deterministic — re-running overwrites
  const createdAt = blog.createdAt;
  const updatedAt = blog.updatedAt ?? blog.createdAt;

  const status = CONTENT_STATUSES.includes(blog.status) ? blog.status : DEFAULT_STATUS;

  const item = {
    ...contentKey(tenantId, contentId),
    entity: "Content",
    tenantId,
    contentId,
    type: "blog", // CONTENT_TYPES includes "blog" (asserted at startup)
    source: "owned", // CONTENT_SOURCES includes "owned" (asserted at startup)
    status,
    // links/ids carry the canonical URL + per-platform copy URLs/ids that the
    // blog accumulated. Mirror them so dual-read sees the same cross-post
    // state. Fall back to the createContent seed shape when absent.
    links: blog.links ?? { url: blog.canonicalUrl },
    ids: blog.ids ?? {},
    gsi1pk: `TENANT#${tenantId}#CONTENT`,
    gsi1sk: `${createdAt}#${contentId}`,
    createdAt,
    updatedAt,
  };

  for (const field of CARRIED_FIELDS) {
    if (blog[field] !== undefined) {
      item[field] = blog[field];
    }
  }

  return item;
}

// ---------------------------------------------------------------------
// Pure transform: Blog crosspost copy row -> Content PUBLISH variant item.
//
// Blog crosspost copies live at sk = BLOG#{blogId}#CROSSPOST#{platform}
// (entity BlogCrosspost) with fields: platform, status, url, id (external
// post id), slug, publishedAt, runId. They map onto the Content PUBLISH
// child at sk = CONTENT#{contentId}#PUBLISH#{platform} (entity ContentPublish).
// Returns null for copies WITHOUT a published url (only published copies are
// migrated). Mirrors the attribute shape of domain putPublishVariant.
// ---------------------------------------------------------------------
export function crosspostCopyToPublishItem(blog, copy) {
  if (!copy.url) return null; // only migrate copies that actually published

  const tenantId = blog.tenantId;
  const contentId = blog.blogId;
  const platform = copy.platform;

  const item = {
    ...publishVariantKey(tenantId, contentId, platform),
    entity: "ContentPublish",
    tenantId,
    contentId,
    platform,
    status: copy.status ?? "succeeded",
    url: copy.url,
    // updatedAt mirrors the publish timestamp rather than "now" so the
    // migrated variant preserves the original publish history.
    updatedAt: copy.publishedAt ?? copy.updatedAt ?? blog.updatedAt ?? blog.createdAt,
  };
  if (copy.id !== undefined) item.id = copy.id;
  if (copy.slug !== undefined) item.slug = copy.slug;
  if (copy.publishedAt !== undefined) item.publishedAt = copy.publishedAt;
  if (copy.runId !== undefined) item.runId = copy.runId;

  return item;
}

// ---------------------------------------------------------------------

const client = new DynamoDBClient({ region: args.region });

let blogsFound = 0;
let contentRows = 0;
let publishChildren = 0;
let skippedCopies = 0;
const samples = [];

// One-shot Scan filtered to blog ROOTS (entity = "Blog") AND their crosspost
// copy children (entity = "BlogCrosspost"). We collect copies keyed by blogId
// so each blog's PUBLISH children can be derived alongside its root. Child
// rows other than crosspost copies carry different entities and are ignored.
const copiesByBlogId = new Map(); // blogId -> [copy, ...]
const blogRoots = [];

const paginator = paginateScan(
  { client, pageSize: 100 },
  {
    TableName: TABLE_NAME,
    FilterExpression: "#entity = :blog OR #entity = :copy",
    ExpressionAttributeNames: { "#entity": "entity" },
    ExpressionAttributeValues: {
      ":blog": { S: "Blog" },
      ":copy": { S: "BlogCrosspost" },
    },
  },
);

for await (const page of paginator) {
  for (const rawItem of page.Items ?? []) {
    const row = unmarshall(rawItem);
    if (row.entity === "Blog") {
      blogRoots.push(row);
    } else if (row.entity === "BlogCrosspost") {
      const list = copiesByBlogId.get(row.blogId) ?? [];
      list.push(row);
      copiesByBlogId.set(row.blogId, list);
    }
  }
}

for (const blog of blogRoots) {
  blogsFound += 1;

  if (!blog.tenantId || !blog.blogId || !blog.createdAt) {
    console.warn(
      `Skipping malformed blog (missing tenantId/blogId/createdAt): pk=${blog.pk} sk=${blog.sk}`,
    );
    continue;
  }

  const contentItem = blogToContentItem(blog);
  const copies = copiesByBlogId.get(blog.blogId) ?? [];
  const publishItems = [];
  for (const copy of copies) {
    const publishItem = crosspostCopyToPublishItem(blog, copy);
    if (publishItem) {
      publishItems.push(publishItem);
    } else {
      skippedCopies += 1;
    }
  }

  if (samples.length < 3) {
    samples.push({ contentItem, publishItems });
  }

  if (!args.apply) {
    console.log(
      `[dry-run] would write Content ${contentItem.tenantId}/${contentItem.contentId} ` +
        `(type=${contentItem.type}, source=${contentItem.source}, status=${contentItem.status}) ` +
        `— "${contentItem.title ?? "(untitled)"}" + ${publishItems.length} PUBLISH child(ren)`,
    );
    contentRows += 1;
    publishChildren += publishItems.length;
    continue;
  }

  // Deterministic overwrite of the Content root (no attribute_not_exists
  // guard so re-runs succeed).
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: contentItem }));
  contentRows += 1;
  console.log(`Wrote Content ${contentItem.tenantId}/${contentItem.contentId}`);

  for (const publishItem of publishItems) {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: publishItem }));
    publishChildren += 1;
    console.log(`  Wrote PUBLISH ${publishItem.platform} → ${publishItem.url}`);
  }
}

// Sample dump (first few transforms) so a dry-run shows the exact shape.
if (samples.length > 0) {
  console.log("---");
  console.log("Sample transform(s):");
  console.log(JSON.stringify(samples, null, 2));
}

console.log("---");
console.log(`Blogs found:        ${blogsFound}`);
console.log(`Content rows:       ${contentRows}`);
console.log(`Publish children:   ${publishChildren}`);
console.log(`Skipped copies (no url): ${skippedCopies}`);
if (!args.apply) {
  console.log("(dry-run; use --apply to write)");
}

function parseArgs(argv) {
  const out = { region: "us-east-1", apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--table") out.table = argv[++i];
    else if (arg === "--region") out.region = argv[++i];
  }
  return out;
}
