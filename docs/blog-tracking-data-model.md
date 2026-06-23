# Blog tracking — data model & key conventions

Design record for the blog-tracking feature ([milestone "Blog tracking v1"](https://github.com/allenheltondev/content-tracking/milestone/1)). This is the source of truth for blog entities, key shapes, and access patterns. Domain code under `api/domain/blog.mjs` and the durable functions under `functions/` follow it.

This is a rebuild of the legacy `readysetcloud/blog-service`. The data-model decisions here deliberately fix the legacy warts (kinds inferred from key shape, a `GSI1` convention that read what nothing wrote, an unseeded canonical URL) **and** make the model multi-tenant from the start, which the legacy service was and the rest of this app is not yet.

## Context

A **blog** is a first-class authored article. It can be cross-posted on demand to Dev.to, Medium, and Hashnode, each of which produces a platform-native **copy**. View counts are pulled back per platform on a weekly schedule. A blog may optionally reference a `Campaign`, but it stands on its own and is never required to belong to one.

All blog entities live in the existing single DynamoDB table (`TABLE_NAME`), keyed `pk`/`sk` with one GSI `GSI1` on `gsi1pk`/`gsi1sk`. Every item carries an explicit `entity` attribute (matching `api/domain/*`), and blog/run ids are ULIDs.

## Multi-tenancy (the load-bearing decision)

Blog entities are **tenant-scoped by partition**. Every blog item lives under `pk = TENANT#{tenantId}`, and `tenantId` is the **Cognito `sub`** the Lambda authorizer puts on the request (`event.requestContext.authorizer.sub`, see `api/authorizer.mjs`).

This is **structural isolation**: a handler reads a tenant's data by querying that tenant's partition, and the `tenantId` it uses always comes from the verified token, never from the request body or path. A caller therefore cannot read or write another tenant's blogs, copies, runs, or analytics — there is no key they can form to reach another partition. This matters specifically for cross-posting: the cross-link rewrite step loads "this tenant's catalog," and a global catalog would let one tenant's article links resolve to another tenant's platform copies.

> **Divergence from the rest of the app (intentional).** Existing entities (`Campaign`, `Vendor`) are single-tenant: they use entity-id partitions (`CAMPAIGN#{id}`) and constant GSI list partitions (`gsi1pk="CAMPAIGNS"`). Blogs are the first tenant-scoped entity. When the broader app moves to the shared Cognito pool, campaigns/vendors adopt the same convention; until then the two coexist in one table. The optional campaign reference (below) is kept inside the tenant partition so isolation holds even though campaigns are not tenant-scoped yet.

Secrets stay out of the table: per-tenant platform tokens live in a SecureString SSM parameter (`/booked/{env}/tenants/{tenantId}/blog-credentials`, see `api/services/blog-credentials.mjs`). The **Tenant** entity below holds only non-secret per-tenant configuration.

## Entities

Keys use uppercase, prefixed, self-describing segments under the tenant partition. `entity` is set on every item.

### 1. Tenant (per-tenant config)

| | |
|---|---|
| `pk` | `TENANT#{tenantId}` |
| `sk` | `#CONFIG` |
| `gsi1pk` | `TENANTS` (constant) |
| `gsi1sk` | `{tenantId}` |
| `entity` | `Tenant` |

Attributes: `tenantId` (Cognito sub), `canonicalBaseUrl` (e.g. `https://readysetcloud.io`), `platforms` (map: `{ dev: { organizationId }, medium: { publicationId }, hashnode: { publicationId, blogUrl } }`), `adminEmail`, `createdAt`, `updatedAt`.

Holds the non-secret per-tenant targets the legacy service **hardcoded** (Medium publication `5517fd7b58a6`, Hashnode publication `626beb20...`, Dev.to org `2491`, the `readysetcloud.io` base URL). Each tenant publishes to their own publications under their own domain, so these must be per-tenant. `sk="#CONFIG"` sorts ahead of `BLOG#`/`SUMMARY#` items. The `gsi1pk="TENANTS"` bucket lets the weekly analytics job **enumerate tenants** (the one intentional cross-tenant read, done by the system, not a user request).

### 2. Blog (canonical article)

| | |
|---|---|
| `pk` | `TENANT#{tenantId}` |
| `sk` | `BLOG#{blogId}` |
| `gsi1pk` | `TENANT#{tenantId}#BLOG` |
| `gsi1sk` | `{createdAt}#{blogId}` |
| `entity` | `Blog` |

Attributes: `blogId` (ULID), `tenantId`, `title`, `slug`, `description`, `image`, `imageAttribution?`, `tags[]`, `categories[]`, `canonicalUrl`, `contentMarkdown`, `campaignId?`, `links` (map), `ids` (map), `createdAt`, `updatedAt`.

- The per-tenant `gsi1pk="TENANT#{tenantId}#BLOG"` is set **only on the blog root item**, so listing a tenant's blogs (and loading the cross-link catalog) is a clean GSI query that returns roots only, never child rows.
- `links` seeds `{ url: canonicalUrl }` at creation, then gains `{ dev, medium, hashnode }` native URLs as copies publish. `parse-blog` reads `links.url` for cross-link rewriting, so it is **seeded explicitly at creation** (a legacy gap).
- `ids` holds the per-platform post id of each copy, used by the analytics job. `slug` is stored without a leading slash.

### 3. Crosspost copy (one per platform)

| | |
|---|---|
| `pk` | `TENANT#{tenantId}` |
| `sk` | `BLOG#{blogId}#CROSSPOST#{platform}` |
| `entity` | `BlogCrosspost` |

Attributes: `tenantId`, `blogId`, `platform` (`dev`\|`medium`\|`hashnode`), `status` (`pending`\|`scheduled`\|`succeeded`\|`failed`), `url?`, `id?`, `scheduledFor?`, `publishedAt?`, `error?`, `runId`.

The `BLOG#{blogId}#` prefix groups a blog's children, so the blog and all its copies/runs/snapshots come back from one `begins_with(sk,"BLOG#{blogId}")` query. A `succeeded` status short-circuits re-publish (idempotency).

### 4. Crosspost run (durable execution state)

| | |
|---|---|
| `pk` | `TENANT#{tenantId}` |
| `sk` | `BLOG#{blogId}#RUN#{runId}` |
| `entity` | `BlogCrosspostRun` |

Attributes: `tenantId`, `blogId`, `runId` (ULID), `status` (`in progress`\|`succeeded`\|`failed`), `platforms[]` (requested), `schedule?` (immediate vs staggered), `executionId?` (durable execution arn/id), `startedAt`, `completedAt?`.

One row per cross-post request. The durable function updates it; the status endpoint reads it alongside the copies.

### 5. View snapshot (weekly analytics)

| | |
|---|---|
| `pk` | `TENANT#{tenantId}` |
| `sk` | `BLOG#{blogId}#VIEWCOUNT#{YYYY-MM-DD}` |
| `entity` | `BlogViewSnapshot` |

Attributes: `tenantId`, `blogId`, `weekly` (map: `{ blog, medium, dev, hashnode, total }` deltas), `allTime` (map: same shape, running totals), `capturedAt`.

Latest prior snapshot for a blog: `Query(pk=TENANT#{tenantId}, begins_with(sk,"BLOG#{blogId}#VIEWCOUNT#"), ScanIndexForward=false, Limit=1)`. Article volume is small, so the weekly job ranks the latest snapshots in memory (no Momento, per the next-gen spec).

### 6. Weekly summary (precomputed ranking)

| | |
|---|---|
| `pk` | `TENANT#{tenantId}` |
| `sk` | `SUMMARY#{YYYY-MM-DD}` |
| `entity` | `BlogWeeklySummary` |

Attributes: `tenantId`, `top` (map of source → top-N `[{ blogId, title, value }]`), `generatedAt`.

Written once per weekly run per tenant so the dashboard reads a single item for "top articles": `Query(pk=TENANT#{tenantId}, begins_with(sk,"SUMMARY#"), ScanIndexForward=false, Limit=1)`. The `SUMMARY#` prefix is tenant-level (not under a blog), so it never collides with `BLOG#` rows.

### 7. Campaign blog-ref (optional reverse lookup)

| | |
|---|---|
| `pk` | `TENANT#{tenantId}` |
| `sk` | `CAMPAIGNREF#{campaignId}#{blogId}` |
| `entity` | `BlogCampaignRef` |

Written when a blog sets `campaignId`, removed when it clears it. Lets a campaign list its referenced blogs cheaply via `begins_with(sk,"CAMPAIGNREF#{campaignId}#")`. Kept **inside the tenant partition** (rather than riding the `CAMPAIGN#` partition like `Link` does) so blog isolation holds even though campaigns are not tenant-scoped yet. The forward direction (blog → campaign) is the `campaignId` attribute on the blog.

## Access patterns

Every read is scoped to `pk = TENANT#{tenantId}` where `tenantId` is the verified Cognito `sub`. The only cross-tenant read is tenant enumeration (#2), performed by the weekly system job.

| # | Need | Operation |
|---|---|---|
| 1 | Get tenant config (publication targets, base URL) | `GetItem` `pk=TENANT#{tenantId}`, `sk=#CONFIG` |
| 2 | Enumerate tenants (weekly job, system) | `Query GSI1` `gsi1pk="TENANTS"` |
| 3 | List a tenant's blogs (dashboard + cross-link catalog) | `Query GSI1` `gsi1pk="TENANT#{tenantId}#BLOG"`, desc |
| 4 | Get a blog (root) | `GetItem` `pk=TENANT#{tenantId}`, `sk=BLOG#{blogId}` |
| 5 | Get a blog with copies/runs/snapshots | `Query` `pk=TENANT#{tenantId}`, `begins_with(sk,"BLOG#{blogId}")` |
| 6 | List a blog's platform copies | `Query` `pk=TENANT#{tenantId}`, `begins_with(sk,"BLOG#{blogId}#CROSSPOST#")` |
| 7 | Read a cross-post run | `GetItem` `pk=TENANT#{tenantId}`, `sk=BLOG#{blogId}#RUN#{runId}` |
| 8 | Latest snapshot for a blog | `Query` `pk=TENANT#{tenantId}`, `begins_with(sk,"BLOG#{blogId}#VIEWCOUNT#")`, desc, limit 1 |
| 9 | Latest weekly summary (top articles) | `Query` `pk=TENANT#{tenantId}`, `begins_with(sk,"SUMMARY#")`, desc, limit 1 |
| 10 | Blogs referenced by a campaign | `Query` `pk=TENANT#{tenantId}`, `begins_with(sk,"CAMPAIGNREF#{campaignId}#")` |
| 11 | Campaign a blog belongs to | `blog.campaignId` attribute |
| 12 | Write / enrich any of the above | `PutItem` / `UpdateItem` on the keys above |

`GSI1` now carries two buckets: `gsi1pk="TENANTS"` (tenant enumeration) and `gsi1pk="TENANT#{tenantId}#BLOG"` (per-tenant blog list), consistent with how the table already uses `gsi1pk` as an entity bucket (`CAMPAIGNS`, `VENDORS`).

## What this fixes / improves over the legacy service

- **True multi-tenancy.** Tenant is the partition root, so isolation is structural and cross-link rewriting is tenant-scoped. The legacy resolved a `tenantId` but the rebuild bakes it into the keys.
- **Per-tenant platform config.** The `Tenant` entity holds the publication IDs and canonical base URL the legacy hardcoded, so cross-posting works for more than one tenant.
- **Explicit `entity` attribute** on every item (legacy told kinds apart by key shape).
- **A `GSI1` convention that reads what is written.** The legacy weekly job queried `GSI1PK="article"` while the only writer wrote `blog#<tenantId>`. Here the per-tenant blog bucket is both written and read.
- **`links.url` seeded at creation**, so `parse-blog` cross-link rewriting has the canonical URL to match against.

## Notes

- `tenantId` is always taken from the authorizer context, never from the client. Domain functions accept `tenantId` as their first argument so the route layer is the single place that maps `sub → tenantId`.
- `removeUndefinedValues` is on in the shared Document client (`api/services/ddb.mjs`), so optional attributes can be left off without manual pruning.
- TTL (`expiresAt`) is available on the table but not used by blog entities in v1. View snapshots are retained for trend history.
