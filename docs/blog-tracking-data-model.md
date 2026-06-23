# Blog tracking — data model & key conventions

Design record for the blog-tracking feature ([milestone "Blog tracking v1"](https://github.com/allenheltondev/content-tracking/milestone/1)). This is the source of truth for blog entities, key shapes, and access patterns. Domain code under `api/domain/blog.mjs` and the durable functions under `functions/` follow it.

This is a rebuild of the legacy `readysetcloud/blog-service`. The data-model decisions here deliberately fix the legacy warts (kinds inferred from key shape, a `GSI1` convention that read what nothing wrote, an unseeded canonical URL).

## Context

A **blog** is a first-class authored article. It can be cross-posted on demand to Dev.to, Medium, and Hashnode, each of which produces a platform-native **copy**. View counts are pulled back per platform on a weekly schedule. A blog may optionally reference a `Campaign`, but it stands on its own and is never required to belong to one.

All blog entities live in the existing single DynamoDB table (`TABLE_NAME`), keyed `pk`/`sk` with one GSI `GSI1` on `gsi1pk`/`gsi1sk`. Every item carries an explicit `entity` attribute (matching `api/domain/*`), and ids are ULIDs.

### Tenancy

v1 is effectively single-tenant (Allen), matching the rest of the codebase. The `GSI1` "list" partitions are **constant strings** per entity type, exactly like `gsi1pk="CAMPAIGNS"` ([`api/domain/campaign.mjs`](../api/domain/campaign.mjs)) and `gsi1pk="VENDORS"` ([`api/domain/vendor.mjs`](../api/domain/vendor.mjs)). Per-tenant scoping is a forward-compat path: swap the constant list partition for a per-tenant one and key the credentials/SSM reads (already per-tenant) off the same id. We do not build that out now.

## Entities

Keys use uppercase, prefixed, self-describing segments. `entity` is set on every item.

### 1. Blog (canonical article)

| | |
|---|---|
| `pk` | `BLOG#{blogId}` |
| `sk` | `BLOG#{blogId}` |
| `gsi1pk` | `BLOGS` (constant) |
| `gsi1sk` | `{createdAt}#{blogId}` |
| `entity` | `Blog` |

Attributes: `blogId` (ULID), `title`, `slug`, `description`, `image`, `imageAttribution?`, `tags[]`, `categories[]`, `canonicalUrl`, `contentMarkdown`, `campaignId?`, `links` (map), `ids` (map), `createdAt`, `updatedAt`.

- `links` seeds `{ url: canonicalUrl }` at creation, then gains `{ dev, medium, hashnode }` native URLs as copies publish. `parse-blog` reads `links.url` for cross-link rewriting, so it is **seeded explicitly at creation** (a legacy gap).
- `ids` holds the per-platform post id of each copy, used by the analytics job.
- `canonicalUrl` is the on-site URL of the post; `slug` is stored without a leading slash.

### 2. Crosspost copy (one per platform)

| | |
|---|---|
| `pk` | `BLOG#{blogId}` |
| `sk` | `CROSSPOST#{platform}` |
| `entity` | `BlogCrosspost` |

Attributes: `platform` (`dev`\|`medium`\|`hashnode`), `status` (`pending`\|`scheduled`\|`succeeded`\|`failed`), `url?`, `id?`, `scheduledFor?`, `publishedAt?`, `error?`, `runId`.

Rides the blog partition so a single query returns the blog and all its copies. A `succeeded` status short-circuits re-publish (idempotency).

### 3. Crosspost run (durable execution state)

| | |
|---|---|
| `pk` | `BLOG#{blogId}` |
| `sk` | `CROSSPOSTRUN#{runId}` |
| `entity` | `BlogCrosspostRun` |

Attributes: `runId` (ULID), `status` (`in progress`\|`succeeded`\|`failed`), `platforms[]` (requested), `schedule?` (immediate vs staggered), `executionId?` (durable execution arn/id), `startedAt`, `completedAt?`.

One row per cross-post request. The durable function updates it; the status endpoint reads it alongside the copies.

### 4. View snapshot (weekly analytics)

| | |
|---|---|
| `pk` | `BLOG#{blogId}` |
| `sk` | `VIEWCOUNT#{YYYY-MM-DD}` |
| `entity` | `BlogViewSnapshot` |

Attributes: `weekly` (map: `{ blog, medium, dev, hashnode, total }` deltas), `allTime` (map: same shape, running totals), `capturedAt`.

No GSI. The latest prior snapshot for a blog is `Query(pk=BLOG#{blogId}, begins_with(sk,"VIEWCOUNT#"), ScanIndexForward=false, Limit=1)`. Article volume is small, so the weekly job ranks the latest snapshots in memory (no Momento, per the next-gen spec).

### 5. Weekly summary (precomputed ranking)

| | |
|---|---|
| `pk` | `BLOGSUMMARY` (constant) |
| `sk` | `{YYYY-MM-DD}` |
| `entity` | `BlogWeeklySummary` |

Attributes: `top` (map of source → top-N `[{ blogId, title, value }]`), `generatedAt`.

Written once per weekly run so the dashboard reads a single item for the "top articles" view: `Query(pk=BLOGSUMMARY, ScanIndexForward=false, Limit=1)` for the most recent.

### 6. Campaign blog-ref (optional reverse lookup)

| | |
|---|---|
| `pk` | `CAMPAIGN#{campaignId}` |
| `sk` | `BLOGREF#{blogId}` |
| `entity` | `BlogRef` |

Written when a blog sets `campaignId`, removed when it clears it. Lets a campaign list its referenced blogs cheaply, mirroring how `Link` rows ride the campaign partition ([`api/domain/link.mjs`](../api/domain/link.mjs)). The forward direction (blog → campaign) is the `campaignId` attribute on the blog.

## Access patterns

| # | Need | Operation |
|---|---|---|
| 1 | List all blogs (dashboard, catalog for cross-link rewrite) | `Query GSI1` `gsi1pk="BLOGS"`, desc |
| 2 | Get a blog | `GetItem` `pk=BLOG#{blogId}`, `sk=BLOG#{blogId}` |
| 3 | Get a blog with copies/runs/snapshots | `Query` `pk=BLOG#{blogId}` (optionally `begins_with(sk, ...)`) |
| 4 | List a blog's platform copies | `Query` `pk=BLOG#{blogId}`, `begins_with(sk,"CROSSPOST#")` |
| 5 | Read a cross-post run | `GetItem` `pk=BLOG#{blogId}`, `sk=CROSSPOSTRUN#{runId}` |
| 6 | Latest snapshot for a blog | `Query` `pk=BLOG#{blogId}`, `begins_with(sk,"VIEWCOUNT#")`, desc, limit 1 |
| 7 | Latest weekly summary (top articles) | `Query` `pk=BLOGSUMMARY`, desc, limit 1 |
| 8 | Blogs referenced by a campaign | `Query` `pk=CAMPAIGN#{campaignId}`, `begins_with(sk,"BLOGREF#")` |
| 9 | Campaign a blog belongs to | `blog.campaignId` attribute |
| 10 | Write / enrich any of the above | `PutItem` / `UpdateItem` on the keys above |

## What this fixes from the legacy service

- **Explicit `entity` attribute** on every item. The legacy table told catalog entries and idempotency records apart only by `pk` shape (both used `sk=blog`).
- **A `GSI1` convention that reads what is written.** The legacy weekly job queried `GSI1PK="article"` while the only writer wrote `blog#<tenantId>`, so it found nothing. Here, blogs are written and listed under `gsi1pk="BLOGS"`.
- **Prefixed, self-describing keys** (`BLOG#`, `CROSSPOST#`, `CROSSPOSTRUN#`, `VIEWCOUNT#`, `BLOGREF#`), so partitions are legible.
- **`links.url` seeded at creation**, so `parse-blog` cross-link rewriting has the canonical URL to match against.

## Notes

- `removeUndefinedValues` is on in the shared Document client ([`api/services/ddb.mjs`](../api/services/ddb.mjs)), so optional attributes can be left off without manual pruning.
- TTL (`expiresAt`) is available on the table but not used by blog entities in v1. View snapshots are retained for trend history.
