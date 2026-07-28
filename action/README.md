# Booked content review — GitHub Action

When a PR in your Hugo repo adds or edits a blog post, this Action registers the
post in Booked, runs the multi-lens review, and posts the suggestions back on the
PR — as one-click GitHub *suggested changes* on changed lines, plus a summary
comment for anything off the diff. The full plan lives in
[`docs/hugo-review-action.md`](../docs/hugo-review-action.md).

Phase B (this Action). Phase A (the API surface it drives) already shipped in the
Booked stack.

## What it does

Two modes, meant for two workflows in the same blog repo: `review` (default) on
the PR, and `publish` on the merge.

### `mode: review` — on a `pull_request`

For each changed `*.md` / `*.markdown` under your posts directory (drafts
skipped):

1. Parse the Hugo front matter (title / slug / date) and split off the body.
2. Upsert into Booked by slug (`GET /content/by-slug/{slug}` → `PATCH`, else `POST`).
3. Start a review and poll it to completion.
4. Read the suggestions and map their body offsets to file lines.
5. Post a PR review with a ```suggestion block per suggestion whose span is on a
   changed line (one-click **Commit suggestion**), and a summary comment for the
   rest. Re-runs update the same summary comment instead of stacking.

### `mode: publish` — on the merge

Once a post lands on the default branch it isn't a draft under review any more,
so its Booked record is brought fully in line with the merged file:

1. Parse the front matter of each merged post (drafts still skipped).
2. Upsert by slug, as in review mode — a post that never went through a review
   PR is created here.
3. Write the final body **and the full metadata set** — title, description,
   tags, categories, publish date, canonical URL — and set the status to
   `published`.

Setting a blog post to `published` is what **starts voice learning**: Booked
captures the post as a voice sample anchored on its publish date, which feeds
embedding, counting, and (at the threshold) a reflection that re-derives your
style profile. Nothing in the workflow calls voice directly — publishing is the
trigger. That's why the front-matter date matters: it's the sample's position on
the recency curve, and without one the sample falls back to whenever the record
happened to be created.

The merged file is the source of truth for metadata, so a description or tag
**removed** from front matter is cleared in Booked. Two fields are left alone:
`canonical_url` is only ever set (never cleared, since you may have filled it in
from the app), and `campaign_id` is app-owned linkage the action never touches.

Both `on: push` to the default branch and `on: pull_request` with
`types: [closed]` work; the push form is in the example below.

## Usage

Ready-to-copy workflows are in [`examples/`](examples): review on PRs
([`hugo-content-review.yml`](examples/hugo-content-review.yml)) and publish on
merge ([`hugo-publish-on-merge.yml`](examples/hugo-publish-on-merge.yml)). Add
the first to your Hugo repo at `.github/workflows/content-review.yml`:

```yaml
# .github/workflows/content-review.yml
name: Content review
on:
  pull_request:
    paths: ['content/**/*.md']

permissions:
  contents: read
  pull-requests: write   # to post review comments

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: allenheltondev/content-tracking/action@main   # or a pinned tag
        with:
          api-url: ${{ vars.BOOKED_API_URL }}
          api-key: ${{ secrets.BOOKED_API_KEY }}
          posts-dir: content/
          platform: blog
```

### Referencing the action

`allenheltondev/content-tracking` is public, so `uses: allenheltondev/content-tracking/action@<ref>`
works from any repo (any owner) — no vendoring or sharing needed. Pin a tag/SHA
in production rather than `@main`. The consuming workflow needs no
`actions/checkout`: the action reads the changed post's content from the PR via
the API, not the checked-out tree.

If you'd rather pin an exact copy you control, you can still **vendor** it — copy
this `action/` folder into your repo (e.g. `.github/actions/content-review/`) and
`uses: ./.github/actions/content-review` — but with a public source that's
optional.

### Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `mode` | no | `review` | `review` (PR) or `publish` (merge). |
| `api-url` | yes | — | Base URL of the Booked API (e.g. `https://api.example.com/v1`). |
| `api-key` | yes | — | Booked API key (mint via `/api-keys`, store as a secret). Sent as the `Authorization` header. |
| `posts-dir` | no | `content/` | Only changed markdown files under this prefix are reviewed. |
| `platform` | no | `''` | Platform for the on-voice (brand) lens grounding (e.g. `blog`). |
| `site-url` | no | `''` | Publish mode: base URL of the live site, used to derive each post's canonical URL. |
| `github-token` | no | `${{ github.token }}` | Token used to post PR comments. |

### Outputs (publish mode)

| Output | Description |
| --- | --- |
| `published` | JSON array of `{ path, content_id, created }`. |
| `published-count` | How many posts were published. |

### Canonical URLs

With `site-url` set, publish mode records each post's canonical URL. It takes an
absolute `canonicalURL` / `canonical_url` / `url` from front matter as written;
otherwise it joins `site-url` with a relative front-matter `url`, or with
Hugo's default permalink (the post's section path plus its slug —
`content/blog/my-post.md` → `/blog/my-post/`). If your site overrides
`permalinks` in config, set `url` in the post's front matter and that wins.
Without `site-url` and without an absolute URL in front matter, `canonical_url`
is left untouched.

### The API key

Mint a Booked API key from the dashboard (`/api-keys`) and store it as the
`BOOKED_API_KEY` secret in the Hugo repo. It's scoped to publisher endpoints:
create/update content, start a review, and read suggestions — it can't resolve
suggestions (accept/reject stays a human action in the app).

## Notes / limits

- GitHub inline comments attach only to lines in the PR diff. A **new** post has
  every line added, so all suggestions can be inline; **edits** get inline
  suggestions on changed lines and the rest in the summary comment.
- Accepting a suggestion here (GitHub "Commit suggestion") does not yet mark it
  accepted in Booked — one-directional for now (see the design doc's Phase C).
- Committing a suggestion pushes, which re-runs this action: the post is
  PATCHed with the new body and reviewed again. Each review supersedes the
  previous one's leftover suggestions in Booked, so the app shows the latest
  round's advice rather than accumulating a set per push.
- If a review doesn't finish inside the poll window (~3 min), that post is
  reported under **Not reviewed** in the summary comment rather than posted as
  a partial result. Re-run the job once it lands.
- Publish mode fails the job if any post fails to publish: nothing downstream
  retries it, and a post that fails silently is a post the voice never learns
  from.
- Tags and categories are trimmed, de-duplicated, and capped at Booked's limits
  (30 entries, 50 chars each); anything past that is dropped rather than 400ing
  the publish.
- Deleting a post from the repo doesn't unpublish it in Booked — removals are
  ignored in both modes. Same for a post whose slug changes: the record under
  the old slug stays, and the new slug registers as a new piece.

## Development

Self-contained npm project. Pure logic (front-matter split, offset→line mapping,
suggested-change reconstruction, the API client, orchestration) is unit-tested;
the entrypoint (`src/index.mjs`) is the Octokit glue.

```bash
cd action
npm install
npm test        # node --test
```
