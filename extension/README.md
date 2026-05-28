# Booked Social Analytics — Chrome extension

A companion Chrome extension for [Booked](../README.md). It reads the social
post URLs attached to your **active** campaigns, and as you browse those
posts on X/Twitter, LinkedIn, and Instagram it captures the engagement
numbers straight off each platform's own API traffic and writes them back
to Booked — automatically, with no clicking. Every write stamps a
`last_fetched` timestamp on the social post.

## How it works

```
                 ┌─────────────────────────── browser tab (a tracked post) ──┐
 page's fetch/XHR │  inject.js  (MAIN world)  ──postMessage──▶  content.js     │
                 └───────────────────────────────────────────────│───────────┘
                                                                  │ chrome.runtime
                                                                  ▼
                                  background.js (service worker)
                                    • OAuth/PKCE against Cognito Hosted UI
                                    • polls GET /monitoring/working-set
                                    • matches captured payload → tracked post
                                    • PUT …/social-posts/{id}/analytics
                                                                  │
                                                                  ▼
                                                          Booked REST API
```

- `inject.js` runs in the page's own JS context and wraps `fetch`/`XHR` so
  it can see responses from the platform's internal analytics endpoints.
- `content.js` relays those responses to the background worker.
- `background.js` extracts metrics with a per-platform adapter
  (`src/adapters.js`), matches them to a tracked post by its native id
  (tweet id / LinkedIn activity id / Instagram shortcode), and syncs.

The extension only ever **reads** post engagement that the page already
loaded for you; it does not scrape logged-out data or take any action on
the platforms.

## Prerequisites

- A deployed Booked stack (you need its `ContentTrackingApiBaseUrl`).
- The shared `RSCUserPool` Cognito user pool with a **Hosted UI domain** and
  a **public app client** (no client secret) that has the *Authorization
  code grant* enabled and `openid` in its allowed scopes.

## Install (load unpacked)

1. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, and select this `extension/` folder.
2. Open the extension's **Settings** (right-click the icon → Options, or the
   "Settings" link in the popup).
3. Copy the **Redirect URI** shown on the settings page. It looks like
   `https://<extension-id>.chromiumapp.org/`.
4. In the Cognito console, edit your app client and add that redirect URI to
   **Allowed callback URLs** (and **Allowed sign-out URLs**). Make sure the
   Authorization code grant and the `openid` scope are enabled.
5. Back on the settings page, fill in:
   - **Booked API base URL** — the stack's `ContentTrackingApiBaseUrl`
     output (include the `/v1` stage if it's the `execute-api` hostname).
   - **Cognito Hosted UI domain** — e.g.
     `https://your-domain.auth.us-east-1.amazoncognito.com`.
   - **App client id**, **region**, and **scopes** (`openid email profile`).
6. Click **Save & grant access**. Chrome will ask permission to access the
   API and Cognito origins — approve it (the extension needs host access to
   call them cross-origin).
7. Open the popup and click **Sign in**. The Cognito Hosted UI opens; after
   you log in the popup shows your tracked posts.

## Using it

1. In the Booked dashboard, open a campaign and add posts under **Social
   posts** (paste the post URL; the platform is auto-detected).
2. Keep the campaign **active**.
3. Browse to those posts in Chrome. When the page loads its engagement data,
   the extension captures and syncs it. Reopen the popup to see the updated
   counts and "fetched … ago" times, or check the campaign in the dashboard.

The post list refreshes every 15 minutes (configurable) and on demand via
**Refresh list** in the popup.

## Configuration & tokens

- Settings and OAuth tokens are stored in `chrome.storage.local`. Nothing is
  a secret: the app client is public and uses PKCE.
- The id token (not the access token) is sent in the `Authorization` header,
  matching the dashboard and the API's Cognito authorizer.

## Maintenance note

The adapters in `src/adapters.js` read undocumented, internal platform API
shapes that change over time. If a platform stops syncing, that's the file
to update — the walkers are defensive and degrade to "no metrics" rather
than breaking the rest of the extension. `extension/__tests__/adapters.test.mjs`
covers the current shapes and runs as part of the repo's `npm test`.
