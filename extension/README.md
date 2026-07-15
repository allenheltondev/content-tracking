# Booked — Chrome extension

The companion Chrome extension for [Booked](../README.md), the creator
platform. It does two things as you browse:

1. **Sync engagement automatically.** It reads the post URLs attached to your
   **active** campaigns — social posts on X/Twitter, LinkedIn, Instagram, and
   Bluesky, plus long-form content posts on Medium and dev.to — and as you
   browse those posts it captures the engagement numbers straight off each
   platform's own API traffic and writes them back to Booked automatically.
   Every write stamps a `last_fetched` timestamp on the post.
2. **Grow your Content Radar.** On any site you read, the popup surfaces the
   site's RSS/Atom feed with one click to add it as a
   [Content Radar](../docs/content-radar.md) source — so the blogs and
   publications you actually follow feed the content-angles agent.

It also injects a **Booked** menu into the host site so you can jump
straight to the posts you're monitoring: a nav item on X and LinkedIn, and
a floating button on Bluesky, Medium, and dev.to (shown only when you have a
tracked post on that platform). LinkedIn, Medium, and dev.to hide their counts
behind a separate analytics/stats page, so for those the worker opens that
page in a background tab, syncs, and closes it — your current tab is left
alone. This is also what the dashboard's **Refresh Stats** button drives.

### Sync now

The popup's **Sync now** button rolls all of that into one click. It sweeps
**every** post you're monitoring — across all campaigns and platforms — and
opens each one's capture page in background tabs collected under a fresh
**"Booked"** Chrome tab group. Tabs open a few at a time (throttled so the
browser isn't swamped) and each closes itself the moment its stats sync, so the
group drains and disappears once the sweep finishes. Nothing is left open and
you never have to visit each post by hand.

## How it works

```
                 ┌─────────────────────────── browser tab (a tracked post) ──┐
 page's fetch/XHR │  inject.js  (MAIN world)  ──postMessage──▶  content.js     │
                 └───────────────────────────────────────────────│───────────┘
                                                                  │ chrome.runtime
                                                                  ▼
                                  background.js (service worker)
                                    • polls GET /monitoring/working-set
                                    • matches captured payload → tracked post
                                    • PUT …/social-posts/{id}/analytics
                                                                  │
                                                                  ▼
                                                          Booked REST API
                                                  (Lambda authorizer verifies
                                                   the pairing token's HMAC
                                                   signature on every call)
```

- `inject.js` runs in the page's own JS context and wraps `fetch`/`XHR` so
  it can see responses from the platform's internal analytics endpoints.
- `content.js` relays those responses to the background worker.
- `background.js` extracts metrics with a per-platform adapter
  (`src/adapters.js`), matches them to a tracked post by its native id
  (tweet id / LinkedIn activity id / Instagram shortcode / Bluesky post rkey /
  Medium post id / dev.to article id), and syncs to the social or content
  endpoint per the post's bucket.

The extension only ever **reads** post engagement that the page already
loaded for you; it does not scrape logged-out data or take any action on
the platforms.

## Content Radar capture

Open the popup on any blog or news site you're reading and it looks for the
page's advertised RSS/Atom feed (`<link rel="alternate">`) and offers to add it
to your [Content Radar](../docs/content-radar.md) with one click
(`POST /content-radar/feeds`). If the feed is already a source it says so
instead of adding a duplicate; if the page advertises no feed it says that too.

This runs only when you open the popup, on the tab you're looking at — it uses
the `activeTab` + `scripting` permissions (opening the popup is the user gesture
that grants them), so the extension carries **no** always-on access to every
site. It reads one thing from the page — the feed `<link>` tags — and only when
you ask. The server re-validates every feed URL (public http(s), SSRF-guarded)
before storing it.

## Install

The dashboard's **Campaign → Promotion** tab has an **Install Chrome
extension** button that opens an in-app modal with a one-click download
of the prepackaged zip. The zip is built by CI on every Booked deploy
with the API URL already baked in, so you don't have to configure
anything beyond pairing.

1. From the dashboard, download `booked-extension.zip` and unzip it.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, and select the `booked-extension` folder you just
   unzipped.
3. Open the dashboard's **Settings → Extension** page and click
   **Generate pairing code**.
4. The extension in that same browser **pairs itself automatically** — the
   dialog confirms it, and the popup switches to showing your tracked posts.
   To set up a *different* browser, paste the code into that browser's
   extension popup **Pairing code** field and click **Pair extension**.

### Automatic pairing

When you generate a pairing code on **Settings → Extension**, the extension's
dashboard content script picks up the freshly minted token straight from the
page and pairs this browser for you — no copy/paste. It only ever does this for
a browser that **isn't paired yet**; an already-paired browser is left alone, so
the visible code is still there for pairing another machine. The handoff stays on
your own dashboard page (the token is already shown there), and the content
script runs only on the dashboard origin.

## Revoking access

The dashboard's **Settings → Extension** page lists every paired device
with a **Revoke** button. Revoking takes effect on the extension's next
API call (the Lambda authorizer rechecks revocation each request).

## How auth works

- The user signs into the dashboard via Cognito as usual.
- On **Settings → Extension** they mint a pairing token. The server
  signs it with an HMAC key stored in Secrets Manager and persists
  only metadata (`jti`, label, created_at, last_used_at) in DynamoDB
  — the token value itself is shown once and never stored.
- The extension stores the pasted token in `chrome.storage.local` and
  sends it as `Authorization: Bearer <token>` on every API call.
- The API's Lambda authorizer accepts both Cognito id tokens (dashboard)
  and HMAC-signed pairing tokens (extension). For pairing tokens it
  verifies the signature, then `GetItem`s the `jti` to confirm the
  pairing hasn't been revoked, and bumps `last_used_at` in the same
  conditional update.

Pairing tokens don't expire on their own. Revocation is the lifecycle —
the dashboard's **Revoke** removes the metadata row, and the next call
that token makes fails the authorizer's existence check.

## Repackaging by hand

CI bakes the API base URL into the zip, but you can repackage locally
for development:

```
VITE_API_BASE_URL="https://your-api.example.com/v1" \
  npm run build-extension-zip
```

The zip lands at `ui/dist/booked-extension.zip`. The script substitutes
the URL into the placeholder in `src/config.js` (`__BOOKED_API_BASE_URL__`)
before zipping.

## Maintenance note

The adapters in `src/adapters.js` read undocumented, internal platform API
shapes that change over time. If a platform stops syncing, that's the file
to update — the walkers are defensive and degrade to "no metrics" rather
than breaking the rest of the extension. `extension/__tests__/adapters.test.mjs`
covers the current shapes and runs as part of the repo's `npm test`.
