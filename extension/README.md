# Booked Social Analytics — Chrome extension

A companion Chrome extension for [Booked](../README.md). It reads the post
URLs attached to your **active** campaigns — social posts on X/Twitter,
LinkedIn, Instagram, and Bluesky, plus long-form content posts on Medium and
dev.to —
and as you browse those posts it captures the engagement numbers straight
off each platform's own API traffic and writes them back to Booked
automatically. Every write stamps a `last_fetched` timestamp on the post.

It also injects a **Booked** menu into the host site so you can jump
straight to the posts you're monitoring: a nav item on X and LinkedIn, and
a floating button on Bluesky, Medium, and dev.to (shown only when you have a
tracked post on that platform). LinkedIn, Medium, and dev.to hide their counts
behind a separate analytics/stats page, so for those the worker opens that
page in a background tab, syncs, and closes it — your current tab is left
alone. This is also what the dashboard's **Refresh Stats** button drives.

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
4. Open the extension popup, paste the code into the **Pairing code**
   field, and click **Pair extension**. The popup switches to showing
   your tracked posts.

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
