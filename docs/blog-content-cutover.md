# Blog → Content write-unification cutover

The content-model unification is read-unified and now write-unified at the API:
new blog writes go to the `Content` entity. What remains is an **operational
cutover** (migrate existing `Blog` rows) followed by a small **code retirement**
that is only safe once no un-migrated `Blog` rows remain.

## Where we are

- **Reads:** unified. `GET /content` merges `Content` + legacy `Blog`-only rows
  (Content wins); `GET /content/:id` falls back to a `Blog` row; `GET /blogs`
  dual-reads.
- **Writes:** `POST/PATCH/DELETE /blogs` now target `Content` (Content-first,
  with a legacy `Blog` fallback on edit/delete for un-migrated posts). No new
  `Blog` rows are created via the API.
- **Still on the Blog entity:** existing (un-migrated) `Blog` rows; the durable
  cross-post pipeline (`POST /blogs/:id/crosspost` → `CrosspostFunction`) which
  reads/writes `Blog` crosspost rows; and `VectorizeBlogFunction`, whose
  `BlogVectorIndex` is **still read by `functions/stream-generate`** via
  `queryBlogChunks`.

## Step 1 — migrate the data (per environment)

`scripts/migrate-blogs-to-content.mjs` is additive and idempotent — it copies
each `Blog` root (+ its published crosspost copies) into `Content` /
`ContentPublish` rows with `contentId = blogId`, and never mutates or deletes
the originals.

```bash
# dry-run first — confirm the counts
AWS_PROFILE=staging node scripts/migrate-blogs-to-content.mjs --table content-tracking
# then apply
AWS_PROFILE=staging node scripts/migrate-blogs-to-content.mjs --table content-tracking --apply
```

Repeat for production. After `--apply`, every legacy blog is a `Content` row, so
`GET /content/:id` returns `content_backed: true` for them and the detail page
exposes the full content controls.

## Step 2 — verify

- Re-run the script in dry-run and confirm `Blogs found` equals the number of
  `Content` rows already present (i.e. nothing left to write).
- Spot-check a few migrated posts in the Content hub (body, tags, publish
  variants).

## Step 3 — code retirement (a follow-up PR, only after Steps 1–2)

Do **not** land these before the migration is applied and verified in every
environment, or un-migrated blogs would disappear from the UI and lose
cross-post.

1. **Move `stream-generate` off the blog vector index.** It calls
   `queryBlogChunks` (`BlogVectorIndex`). Point it at `queryContentChunks`
   (scoped `type="blog"`), matching what `POST /blogs/ask` already does. This is
   the prerequisite for retiring `VectorizeBlogFunction`.
2. **Retire `VectorizeBlogFunction`** and its DLQ + `BlogVectorIndex` bucket in
   `template.yaml` (only after step 1 — nothing reads the index anymore).
3. **Drop the dual-read branching:** the `content_backed` / `blog_backed` flags
   and the `Blog` fallbacks in `GET/DELETE /content/:id`, `PATCH/DELETE /blogs`,
   and the `GET /content` / `GET /blogs` merges.
4. **Retire the legacy blog routes** that no longer have a distinct entity:
   `POST/PATCH/DELETE /blogs` (now Content-first) and, once the cross-post
   pipeline is migrated to Content, `POST /blogs/:id/crosspost`.
5. **Cross-post:** decide whether to migrate the durable staggered pipeline to
   read/write `Content` crosspost rows, or standardize on the synchronous
   `POST /content/:id/crosspost` path (immediate publish, no stagger) and retire
   the durable one. This is the one open design decision; everything above is
   mechanical.
