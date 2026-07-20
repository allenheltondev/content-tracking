# Booked content review — GitHub Action

When a PR in your Hugo repo adds or edits a blog post, this Action registers the
post in Booked, runs the multi-lens review, and posts the suggestions back on the
PR — as one-click GitHub *suggested changes* on changed lines, plus a summary
comment for anything off the diff. The full plan lives in
[`docs/hugo-review-action.md`](../docs/hugo-review-action.md).

Phase B (this Action). Phase A (the API surface it drives) already shipped in the
Booked stack.

## What it does

On a `pull_request`, for each changed `*.md` / `*.markdown` under your posts
directory (drafts skipped):

1. Parse the Hugo front matter (title / slug / date) and split off the body.
2. Upsert into Booked by slug (`GET /content/by-slug/{slug}` → `PATCH`, else `POST`).
3. Start a review and poll it to completion.
4. Read the suggestions and map their body offsets to file lines.
5. Post a PR review with a ```suggestion block per suggestion whose span is on a
   changed line (one-click **Commit suggestion**), and a summary comment for the
   rest. Re-runs update the same summary comment instead of stacking.

## Usage

A ready-to-copy workflow is in [`examples/hugo-content-review.yml`](examples/hugo-content-review.yml).
Add it to your Hugo repo at `.github/workflows/content-review.yml`:

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
| `api-url` | yes | — | Base URL of the Booked API (e.g. `https://api.example.com/v1`). |
| `api-key` | yes | — | Booked API key (mint via `/api-keys`, store as a secret). Sent as the `Authorization` header. |
| `posts-dir` | no | `content/` | Only changed markdown files under this prefix are reviewed. |
| `platform` | no | `''` | Platform for the on-voice (brand) lens grounding (e.g. `blog`). |
| `github-token` | no | `${{ github.token }}` | Token used to post PR comments. |

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

## Development

Self-contained npm project. Pure logic (front-matter split, offset→line mapping,
suggested-change reconstruction, the API client, orchestration) is unit-tested;
the entrypoint (`src/index.mjs`) is the Octokit glue.

```bash
cd action
npm install
npm test        # node --test
```
