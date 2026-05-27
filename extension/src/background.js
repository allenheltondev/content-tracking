// Service worker: the extension's brain. It keeps a cached feed of social
// posts on active campaigns, listens for engagement payloads the content
// scripts capture off each platform's own API traffic, matches them to a
// tracked post, and writes the metrics back to Booked — all without any
// user interaction.

import { getConfig, isConfigured } from "./config.js";
import { adapters } from "./adapters.js";
import { getActivePosts, putAnalytics } from "./api.js";
import { getSession, isSignedIn, signIn, signOut } from "./auth.js";

const FEED_KEY = "booked_feed";
const SENT_KEY = "booked_sent";
const FEED_ALARM = "booked:feed-refresh";

let feed = null;
let feedAt = 0;
let lastError = null;
let syncedThisSession = 0;

// ---- feed -----------------------------------------------------------------

async function loadFeedFromStorage() {
  const stored = (await chrome.storage.local.get(FEED_KEY))[FEED_KEY];
  if (stored?.posts) {
    feed = stored.posts;
    feedAt = stored.at || 0;
  }
}

async function ensureFeed(force = false) {
  const cfg = await getConfig();
  if (!isConfigured(cfg) || !(await isSignedIn())) {
    feed = null;
    updateBadge();
    return null;
  }
  const ttl = (cfg.feedRefreshMinutes || 15) * 60_000;
  if (!force && feed && Date.now() - feedAt < ttl) return feed;

  try {
    feed = await getActivePosts();
    feedAt = Date.now();
    lastError = null;
    await chrome.storage.local.set({ [FEED_KEY]: { posts: feed, at: feedAt } });
  } catch (err) {
    lastError = String(err?.message || err);
    console.warn("[booked] feed refresh failed:", lastError);
  }
  updateBadge();
  return feed;
}

function updateBadge() {
  const count = feed?.length ?? 0;
  chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
}

// ---- capture handling -----------------------------------------------------

async function handleCaptured({ platform, body, pageUrl }) {
  const adapter = adapters[platform];
  if (!adapter) return;

  await ensureFeed();
  if (!feed?.length) return;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }

  const extracted = adapter.extract(parsed);
  if (!extracted.length) return;

  const platformPosts = feed.filter((p) => p.platform === platform);
  if (!platformPosts.length) return;

  const byNativeId = new Map();
  for (const post of platformPosts) {
    const id = adapter.parsePostId(post.url);
    if (id) byNativeId.set(String(id), post);
  }

  // Fallback target: the tracked post for the page we're currently on.
  // Used when a payload carries metrics but no resolvable id (common on
  // LinkedIn/Instagram single-post views).
  const pageId = adapter.parsePostId(pageUrl || "");
  const pagePost = pageId ? byNativeId.get(String(pageId)) : null;

  for (const { nativeId, metrics } of extracted) {
    let post = nativeId != null ? byNativeId.get(String(nativeId)) : null;
    if (!post && nativeId == null) post = pagePost;
    if (post) await maybeSync(post, metrics);
  }
}

function shallowEqual(a, b) {
  if (!a || !b) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

async function maybeSync(post, metrics) {
  // A single response may only carry part of the picture (e.g. just
  // likes). Merge over what we already know so the server-side wholesale
  // replace never drops a previously-captured metric.
  const merged = { ...(post.analytics || {}), ...metrics };

  const sentStore = (await chrome.storage.local.get(SENT_KEY))[SENT_KEY] || {};
  const previous = sentStore[post.post_id] || post.analytics;
  if (previous && shallowEqual(previous, merged)) return;

  try {
    const updated = await putAnalytics(
      post.campaign_id,
      post.post_id,
      merged,
      new Date().toISOString(),
    );
    post.analytics = updated.analytics;
    post.last_fetched = updated.last_fetched;
    sentStore[post.post_id] = merged;
    await chrome.storage.local.set({
      [SENT_KEY]: sentStore,
      [FEED_KEY]: { posts: feed, at: feedAt },
    });
    syncedThisSession += 1;
    console.debug("[booked] synced", post.platform, post.post_id, merged);
  } catch (err) {
    lastError = String(err?.message || err);
    console.warn("[booked] sync failed:", lastError);
  }
}

// ---- status / popup bridge ------------------------------------------------

async function buildStatus() {
  const cfg = await getConfig();
  const configured = isConfigured(cfg);
  const signedIn = configured && (await isSignedIn());
  const session = signedIn ? await getSession() : null;
  return {
    configured,
    signedIn,
    email: session?.email || null,
    posts: signedIn ? feed || [] : [],
    activeCount: feed?.length ?? 0,
    syncedThisSession,
    lastError,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case "booked:captured":
      handleCaptured(msg).catch((err) => console.warn("[booked]", err));
      return false;
    case "booked:status":
      buildStatus().then(sendResponse);
      return true;
    case "booked:refreshFeed":
      ensureFeed(true)
        .then(() => buildStatus())
        .then(sendResponse);
      return true;
    case "booked:signIn":
      signIn()
        .then(() => ensureFeed(true))
        .then(() => buildStatus())
        .then(sendResponse)
        .catch((err) => sendResponse({ error: String(err?.message || err) }));
      return true;
    case "booked:signOut":
      signOut()
        .then(() => {
          feed = null;
          syncedThisSession = 0;
          updateBadge();
        })
        .then(() => buildStatus())
        .then(sendResponse);
      return true;
    default:
      return false;
  }
});

// ---- lifecycle ------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FEED_ALARM) ensureFeed(true);
});

async function init() {
  await loadFeedFromStorage();
  const cfg = await getConfig();
  chrome.alarms.create(FEED_ALARM, { periodInMinutes: cfg.feedRefreshMinutes || 15 });
  updateBadge();
  ensureFeed();
}

chrome.runtime.onInstalled.addListener(() => void init());
chrome.runtime.onStartup.addListener(() => void init());
// Cold-start of the worker outside those events (e.g. first capture event).
void init();
