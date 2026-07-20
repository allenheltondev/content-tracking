# Hugo → content review GitHub Action

A GitHub Action that, when you open a PR adding or editing a blog post in your
Hugo repo, registers the post in Booked, runs the multi-lens review, and posts
the suggestions back onto the PR — as one-click GitHub *suggested changes* where
the diff allows, plus a summary comment. So the copyedit team runs inside your
normal git workflow, before you merge.

Status: **Phase A landed** (backend enablers). The Action itself (Phase B) is
planned.

## Decisions

- **PR surface:** inline GitHub suggested-changes (```suggestion blocks →
  one-click "Commit suggestion") on diffed lines, plus a summary comment for
  everything else. Mirrors the app's accept/reject, git-native.
- **Content identity:** look up by **slug** — the Action resolves a post's Hugo
  slug to its Booked content record to decide create-vs-update. No changes to
  your post files.
- **Scope (first cut):** runs on `pull_request`, one-directional (Booked → PR).
  Publish-on-merge and two-way sync (a committed suggestion flowing back to mark
  the app suggestion accepted) are later.

## How it fits Booked

The review engine, the Content entity, and API-key auth already exist. The Action
is a thin CI client over the existing HTTP API — it adds no server-side review
logic.

```
Hugo repo PR ──> Action (API key) ──> Booked
  changed .md        upsert by slug      POST/PATCH /content
                     start review        POST /content/{id}/reviews
                     poll to done        GET  /content/{id}/reviews/{id}
                     read suggestions     GET  /content/{id}/suggestions
  PR review    <──  map offsets→lines
  + summary          post via GITHUB_TOKEN
```

## Phase A — backend enablers ✅ (landed)

The API-key (automation) path previously reached only `POST /content`. Opened the
minimum additional surface a CI hook needs — everything the Action does, nothing
that belongs to a human in the dashboard:

- **`PATCH /content/{id}`**, **`POST /content/{id}/reviews`**,
  **`GET /content/{id}/reviews/{reviewId}`**, **`GET /content/{id}/suggestions`**
  now use `requirePublisherTenantId` (dashboard **or** API key). The Chrome
  extension is still rejected, and the accept/reject status endpoint
  (`POST .../suggestions/{id}/status`) stays cognito-only — resolving a
  suggestion is a human action in the app.
- **Slug lookup:** `GET /content/by-slug/{slug}` (publisher-scoped) resolves a
  slug to its content record or 404s; `GET /content` also accepts a `slug`
  filter. Backed by `findContentBySlug` in the domain (walks the tenant's content
  index with a slug filter — personal-scale).
- Tests: domain (`findContentBySlug`, slug filter) + route (by-slug lookup,
  API-key access to PATCH, extension still rejected, slug filter forwarded).

An API key is minted via the existing `/api-keys` route and stored as a GitHub
secret in the Hugo repo.

## Phase B — the Action (planned)

A reusable action referenced from the Hugo repo's PR workflow, holding
`CONTENT_REVIEW_API_KEY` + `CONTENT_REVIEW_API_URL` secrets and the repo's native
`GITHUB_TOKEN`.

1. **Detect** changed `.md` posts in the PR diff (under the posts dir).
2. **Parse** Hugo front matter (title / slug / date; skip `draft: true`); the
   body is everything after the front matter.
3. **Upsert:** `GET /content/by-slug/{slug}` → `PATCH` its `content_markdown`
   (+ metadata) if found, else `POST /content`. Capture the `contentId`.
4. **Review:** `POST /content/{id}/reviews` → poll
   `GET /content/{id}/reviews/{reviewId}` to `succeeded`/`failed` (bounded, a few
   minutes).
5. **Read** `GET /content/{id}/suggestions`.
6. **Map** each suggestion's character offsets (into the body) to file line/col,
   adding the front-matter line count above the body.
7. **Post back** via the GitHub API:
   - Suggestions whose span sits on **diffed lines** → a PR review comment with a
     ```suggestion block: the affected line(s) with `[startCol..endCol]` replaced
     by `replace_with` (whole-line reconstruction, since GitHub suggestions
     replace whole lines). One-click apply.
   - Everything else → a **summary comment** grouped by lens, carrying the
     review's verdict + summary, tagged with a hidden marker so re-runs update it
     instead of stacking.

### Constraints (design accounts for these)

- **Diff-only inline:** GitHub inline comments / suggested-changes attach only to
  lines in the PR diff. New posts (all lines added) → full inline; edits →
  inline on changed lines, summary for the rest.
- **Front-matter offset:** offsets index into the body; the file has front matter
  above it, so line mapping adds that offset.
- **Whole-line suggestions:** `replace_with` is a substring; a ```suggestion
  replaces whole lines, so the block reconstructs the full line(s).

## Phase C — later (out of first cut)

- **Publish-on-merge:** on push to main, mark the post `published` (which feeds
  Voice auto-capture via the content stream).
- **Two-way sync:** a committed GitHub suggestion (or a resolved thread) flowing
  back to mark the Booked suggestion accepted/rejected — needs a webhook into the
  app.
