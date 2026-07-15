// Service worker: the extension's brain. It keeps a cached working set of
// social posts and cross-post links on campaigns in the "monitoring"
// phase, listens for engagement payloads the content scripts capture off
// each platform's own API traffic, matches them to a tracked post, and
// writes the metrics back to Booked — all without any user interaction.

import { getConfig, isConfigured } from "./config.js";
import { adapters, PLATFORM_BUCKET } from "./adapters.js";
import { getMonitoringWorkingSet, putAnalytics, listRadarFeeds, addRadarFeed } from "./api.js";
import {
  clearPairing,
  getPairingMetadata,
  isPaired,
  setPairingToken,
} from "./pairing.js";

const FEED_KEY = "booked_feed";
const SENT_KEY = "booked_sent";
const FEED_ALARM = "booked:feed-refresh";
// Maps LinkedIn slug URLs (linkedin.com/posts/<slug>) to the activity
// URN id discovered on that page. Slug URLs embed share/ugcPost ids
// that don't translate to activity ids, so we resolve and cache the
// mapping the first time the user visits any tracked post.
const LINKEDIN_URN_MAP_KEY = "booked_linkedin_urn_map";

let feed = null;
let crossPostLinks = [];
let feedAt = 0;
let lastError = null;
let syncedThisSession = 0;

// ---- feed -----------------------------------------------------------------

async function loadFeedFromStorage() {
  const stored = (await chrome.storage.local.get(FEED_KEY))[FEED_KEY];
  if (stored?.posts) {
    feed = stored.posts;
    crossPostLinks = stored.crossPostLinks || [];
    feedAt = stored.at || 0;
  }
}

async function ensureFeed(force = false) {
  const cfg = await getConfig();
  if (!isConfigured(cfg) || !(await isPaired())) {
    feed = null;
    crossPostLinks = [];
    updateBadge();
    return null;
  }
  const ttl = (cfg.feedRefreshMinutes || 15) * 60_000;
  if (!force && feed && Date.now() - feedAt < ttl) return feed;

  try {
    const workingSet = await getMonitoringWorkingSet();
    // Tag each post with its bucket so the sync path knows which endpoint
    // to PUT to (social vs content). A platform belongs to exactly one
    // bucket per PLATFORM_BUCKET, so the union stays unambiguous when the
    // adapter dispatches by platform.
    feed = [
      ...workingSet.socialPosts.map((p) => ({ ...p, bucket: "social" })),
      ...workingSet.contentPosts.map((p) => ({ ...p, bucket: "content" })),
    ];
    crossPostLinks = workingSet.crossPostLinks;
    feedAt = Date.now();
    lastError = null;
    await chrome.storage.local.set({
      [FEED_KEY]: { posts: feed, crossPostLinks, at: feedAt },
    });
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
    if (post) {
      await maybeSync(post, metrics);
      // Close the tab if this capture came from a refresh we initiated.
      // Safe to call unconditionally — it's a no-op for tabs we didn't open.
      void closeBackgroundScrapeTab(post.post_id);
    }
  }
}

function shallowEqual(a, b) {
  if (!a || !b) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

// Serializes syncs per post. Two captured responses for the same post can
// arrive back-to-back (e.g. one carries likes, the next carries comments);
// running them concurrently would let both build `merged` from the same
// stale snapshot, and since the API replaces the analytics map wholesale
// the later PUT would drop the other's keys. Chaining per post id forces
// the second sync to read the first's result before merging.
const syncChains = new Map();

function maybeSync(post, metrics) {
  const prior = syncChains.get(post.post_id) || Promise.resolve();
  const run = prior.catch(() => {}).then(() => syncPost(post, metrics));
  syncChains.set(post.post_id, run);
  run.finally(() => {
    if (syncChains.get(post.post_id) === run) syncChains.delete(post.post_id);
  });
  return run;
}

async function syncPost(post, metrics) {
  // A single response may only carry part of the picture (e.g. just
  // likes). Merge over what we already know so the server-side wholesale
  // replace never drops a previously-captured metric.
  const merged = { ...(post.analytics || {}), ...metrics };

  const sentStore = (await chrome.storage.local.get(SENT_KEY))[SENT_KEY] || {};
  const previous = sentStore[post.post_id] || post.analytics;
  if (previous && shallowEqual(previous, merged)) return;

  try {
    // The bucket on each post (stamped in ensureFeed) decides which
    // analytics endpoint to write to. Default to social so a feed row
    // missing the field — e.g. one persisted by an older extension
    // build — still syncs through the existing path.
    const bucket = post.bucket ?? PLATFORM_BUCKET[post.platform] ?? "social";
    const updated = await putAnalytics(
      bucket,
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
      [FEED_KEY]: { posts: feed, crossPostLinks, at: feedAt },
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
  const paired = configured && (await isPaired());
  const pairingMetadata = paired ? await getPairingMetadata() : null;
  return {
    configured,
    paired,
    paired_at: pairingMetadata?.paired_at ?? null,
    posts: paired ? feed || [] : [],
    crossPostLinks: paired ? crossPostLinks || [] : [],
    activeCount: feed?.length ?? 0,
    crossPostLinkCount: crossPostLinks?.length ?? 0,
    syncedThisSession,
    lastError,
  };
}

async function getLinkedInUrnMap() {
  const data = await chrome.storage.local.get(LINKEDIN_URN_MAP_KEY);
  return data[LINKEDIN_URN_MAP_KEY] || {};
}

async function setLinkedInUrnMapping(slugUrl, activityId) {
  if (!slugUrl || !activityId) return;
  const map = await getLinkedInUrnMap();
  const key = stripUrlQuery(slugUrl);
  if (map[key] === String(activityId)) return;
  map[key] = String(activityId);
  await chrome.storage.local.set({ [LINKEDIN_URN_MAP_KEY]: map });
}

function stripUrlQuery(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    const i = url.indexOf("?");
    return i > -1 ? url.slice(0, i) : url;
  }
}

// Match a tracked LinkedIn post by activity id. The stored URL may
// embed the activity URN directly (feed/update form) or a share/ugcPost
// id whose mapping we discovered via posts-linkedin.js — try both.
function findLinkedInPostByActivityId(posts, activityId, urnMap) {
  const wanted = String(activityId);
  return posts.find((p) => {
    if (p.platform !== "linkedin") return false;
    if (p.url.includes(`urn:li:activity:${wanted}`)) return true;
    if (urnMap[stripUrlQuery(p.url)] === wanted) return true;
    return false;
  });
}

async function handleScraped({ platform, nativeId, metrics }) {
  if (!metrics || !Object.keys(metrics).length) return;
  await ensureFeed();
  if (!feed?.length) return;

  let matched;
  if (platform === "linkedin") {
    const urnMap = await getLinkedInUrnMap();
    matched = findLinkedInPostByActivityId(feed, nativeId, urnMap);
  } else {
    const adapter = adapters[platform];
    if (!adapter) return;
    matched = feed
      .filter((p) => p.platform === platform)
      .find((p) => {
        const id = adapter.parsePostId(p.url);
        return id && String(id) === String(nativeId);
      });
  }

  if (matched) {
    await maybeSync(matched, metrics);
    // If this scrape was driven by an auto-opened background tab, clean
    // it up. closeBackgroundScrapeTab no-ops if the post isn't tracked
    // in ACTIVE_SCRAPE_TABS, so user-opened tabs are untouched.
    void closeBackgroundScrapeTab(matched.post_id);
  }
}

async function handleResolvedPost({ url, activityId }) {
  if (!url || !activityId) return;
  await setLinkedInUrnMapping(url, activityId);
  // The tabs.onUpdated handler may have already tried (and failed)
  // auto-scrape for this URL before the mapping existed — re-run with
  // the resolved id so the analytics tab opens immediately.
  await maybeAutoScrape(url);
}

// ---- automatic background-tab scrape -------------------------------------
//
// When the user lands on a tracked post via the platform's own UI (a feed
// click, a notification, a saved permalink), the page they're on often
// can't yield the counts: LinkedIn keeps them on the post-summary analytics
// page, Medium on the per-post stats page, dev.to on the article's /stats
// page. Open that capture-triggering URL in a background tab so the
// interceptor fires there, sync the data, then close the tab. The user
// stays on the page they actually wanted to read.

const RECENT_AUTO_SCRAPES = new Map(); // post_id -> timestamp
const ACTIVE_SCRAPE_TABS = new Map(); // post_id -> { tabId, timeoutHandle }
const AUTO_SCRAPE_TTL_MS = 5 * 60 * 1000; // don't re-open within 5 min
const AUTO_SCRAPE_MAX_LIFETIME_MS = 60 * 1000; // hard cap on tab lifetime

// Open a background tab for the given tracked post and register it so the
// scrape-and-close pipeline can clean it up once metrics land. No-op if a
// scrape tab is already in flight for this post.
async function openScrapeTab(post, url) {
  if (ACTIVE_SCRAPE_TABS.has(post.post_id)) return;
  let newTab;
  try {
    newTab = await chrome.tabs.create({ url, active: false });
  } catch (err) {
    console.warn("[booked] scrape tab open failed:", err);
    return;
  }
  const timeoutHandle = setTimeout(() => {
    // Fallback: nothing reported back (page errored, user wasn't logged
    // in, platform changed its DOM/API shape, etc.). Close the orphan.
    ACTIVE_SCRAPE_TABS.delete(post.post_id);
    chrome.tabs.remove(newTab.id).catch(() => {});
  }, AUTO_SCRAPE_MAX_LIFETIME_MS);
  ACTIVE_SCRAPE_TABS.set(post.post_id, { tabId: newTab.id, timeoutHandle });
}

// Which tracked-post platform a freshly-loaded tab belongs to, if any.
function platformForTabUrl(url) {
  if (url.includes("linkedin.com")) return "linkedin";
  if (url.includes("medium.com")) return "medium";
  if (url.includes("dev.to")) return "devto";
  return null;
}

// True when the tab is already on the capture-triggering page for its
// platform. Those pages capture passively, so re-opening would just recurse
// on the very background tab we open ourselves.
function isScrapeDestination(platform, url) {
  if (platform === "linkedin") return url.includes("/analytics/post-summary/");
  if (platform === "medium") return url.includes("/me/stats");
  if (platform === "devto") {
    try {
      return new URL(url).pathname.replace(/\/$/, "").endsWith("/stats");
    } catch {
      return false;
    }
  }
  return false;
}

async function maybeAutoScrape(tabUrl) {
  if (!tabUrl) return;
  const platform = platformForTabUrl(tabUrl);
  if (!platform) return;
  if (isScrapeDestination(platform, tabUrl)) return;

  await ensureFeed();
  if (!feed?.length) return;

  const urnMap = platform === "linkedin" ? await getLinkedInUrnMap() : {};
  let tracked = null;
  if (platform === "linkedin") {
    // Activity id may be embedded directly in the URL (feed/update form)
    // or only available via the slug→activity cache populated by
    // posts-linkedin.js. If neither resolves, we'll get another shot when
    // the content script reports back via booked:resolvedPost.
    let activityId = /urn:li:activity:(\d+)/.exec(tabUrl)?.[1] || null;
    if (!activityId) activityId = urnMap[stripUrlQuery(tabUrl)] || null;
    if (!activityId) return;
    tracked = findLinkedInPostByActivityId(feed, activityId, urnMap);
  } else {
    // Medium/dev.to: match the tracked content post by the platform-native
    // id parsed out of both the tab URL and each stored post URL.
    const adapter = adapters[platform];
    const id = adapter?.parsePostId(tabUrl);
    if (!id) return;
    tracked = feed.find(
      (p) => p.platform === platform && String(adapter.parsePostId(p.url)) === String(id),
    );
  }
  if (!tracked) return;

  // Dedupe: skip if we synced this post in the last few minutes or there's
  // already an in-flight scrape tab for it.
  const recent = RECENT_AUTO_SCRAPES.get(tracked.post_id);
  if (recent && Date.now() - recent < AUTO_SCRAPE_TTL_MS) return;
  if (ACTIVE_SCRAPE_TABS.has(tracked.post_id)) return;

  const url = await scrapeUrlForPost(tracked, urnMap);
  if (!url) return;
  RECENT_AUTO_SCRAPES.set(tracked.post_id, Date.now());
  await openScrapeTab(tracked, url);
}

// Build the URL to open in a background tab for a given tracked post so
// the right capture path fires. LinkedIn needs the analytics post-summary
// page (DOM scrape); Medium needs the per-post stats detail page and dev.to
// the article's /stats page (both fire the internal stats request the
// MAIN-world interceptor catches); Twitter/Instagram/Bluesky just need the
// post URL, where the interceptor catches the platform's own API responses.
async function scrapeUrlForPost(post, urnMap) {
  if (post.platform === "linkedin") {
    let activityId = /urn:li:activity:(\d+)/.exec(post.url)?.[1] || null;
    if (!activityId) activityId = urnMap[stripUrlQuery(post.url)] || null;
    if (!activityId) return null;
    return `https://www.linkedin.com/analytics/post-summary/urn:li:activity:${activityId}/`;
  }
  if (post.platform === "medium") {
    const id = adapters.medium.parsePostId(post.url);
    return id ? `https://medium.com/me/stats/post/${id}` : null;
  }
  if (post.platform === "devto") {
    try {
      const u = new URL(post.url);
      u.search = "";
      u.hash = "";
      u.pathname = u.pathname.replace(/\/$/, "").replace(/\/stats$/, "") + "/stats";
      return u.toString();
    } catch {
      return null;
    }
  }
  if (
    post.platform === "twitter" ||
    post.platform === "instagram" ||
    post.platform === "bluesky"
  ) {
    return post.url;
  }
  return null;
}

// Dashboard "Refresh stale" button entry point. For every tracked post in
// the campaign whose analytics weren't synced today, open a background
// tab on the URL that triggers a capture. The scrape-and-close pipeline
// (handleScraped / handleCaptured) closes each tab once its post syncs.
async function refreshStaleForCampaign(campaignId) {
  if (!campaignId) return { triggered: 0 };
  await ensureFeed();
  if (!feed?.length) return { triggered: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const stale = feed.filter((p) => {
    if (p.campaign_id !== campaignId) return false;
    if (!p.last_fetched) return true;
    return String(p.last_fetched).slice(0, 10) !== today;
  });

  const urnMap = await getLinkedInUrnMap();
  let triggered = 0;
  for (const post of stale) {
    // If a previous scrape tab for this post is still being tracked but
    // the tab itself is gone, drop the stale entry; otherwise skip and
    // let the in-flight one finish.
    const existing = ACTIVE_SCRAPE_TABS.get(post.post_id);
    if (existing) {
      try {
        await chrome.tabs.get(existing.tabId);
        continue;
      } catch {
        clearTimeout(existing.timeoutHandle);
        ACTIVE_SCRAPE_TABS.delete(post.post_id);
      }
    }
    // Bypass the 5-min recent-scrape guard so on-demand refresh always runs.
    RECENT_AUTO_SCRAPES.delete(post.post_id);

    const url = await scrapeUrlForPost(post, urnMap);
    if (!url) continue;
    await openScrapeTab(post, url);
    triggered += 1;
  }

  return { triggered };
}

async function closeBackgroundScrapeTab(postId) {
  const info = ACTIVE_SCRAPE_TABS.get(postId);
  if (!info) return;
  ACTIVE_SCRAPE_TABS.delete(postId);
  clearTimeout(info.timeoutHandle);
  try {
    const t = await chrome.tabs.get(info.tabId);
    // If the user clicked into the tab while we were scraping, leave it
    // open — they likely want to read the analytics view themselves.
    if (!t.active) chrome.tabs.remove(info.tabId).catch(() => {});
  } catch {
    /* tab already closed */
  }
}

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  void maybeAutoScrape(tab?.url);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case "booked:captured":
      handleCaptured(msg).catch((err) => console.warn("[booked]", err));
      return false;
    case "booked:scraped":
      handleScraped(msg).catch((err) => console.warn("[booked]", err));
      return false;
    case "booked:resolvedPost":
      handleResolvedPost(msg).catch((err) => console.warn("[booked]", err));
      return false;
    case "booked:status":
      buildStatus().then(sendResponse);
      return true;
    case "booked:refreshStale":
      refreshStaleForCampaign(msg.campaignId)
        .then(sendResponse)
        .catch((err) => sendResponse({ error: String(err?.message || err) }));
      return true;
    case "booked:refreshFeed":
      ensureFeed(true)
        .then(() => buildStatus())
        .then(sendResponse);
      return true;
    case "booked:radarFeeds":
      listRadarFeeds()
        .then((feeds) => sendResponse({ feeds }))
        .catch((err) => sendResponse({ error: String(err?.message || err) }));
      return true;
    case "booked:addRadarFeed":
      addRadarFeed(msg.url, msg.title)
        .then((feed) => sendResponse({ ok: true, feed }))
        .catch((err) => sendResponse({ error: String(err?.message || err) }));
      return true;
    case "booked:pair":
      setPairingToken(msg.token)
        .then(() => ensureFeed(true))
        .then(() => buildStatus())
        .then(sendResponse)
        .catch((err) => sendResponse({ error: String(err?.message || err) }));
      return true;
    case "booked:unpair":
      clearPairing()
        .then(() => {
          feed = null;
          crossPostLinks = [];
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
