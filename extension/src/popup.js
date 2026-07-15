// Popup UI. All real work lives in the background service worker; the
// popup just renders status, captures the pairing-code paste, and
// forwards button intents.

import { getConfig } from "./config.js";
import { normalizeDiscoveredFeeds, sameFeed } from "./feeds.js";

const content = document.getElementById("content");
const syncedEl = document.getElementById("synced");

// The API's title label caps at 200 chars; clamp client-side so a long
// document.title doesn't get bounced with a 400.
const FEED_TITLE_MAX = 200;

// Asks Chrome for cross-origin access to the API host. The packaged zip
// bakes this into manifest host_permissions at build time (so this call
// resolves true immediately with no prompt); for load-unpacked from the
// source folder the user gets a single permission prompt the first time
// they pair. Must be invoked from a user gesture, which the pair-button
// click handler provides.
async function ensureApiHostAccess() {
  const cfg = await getConfig();
  if (!cfg.apiBaseUrl) return false;
  let pattern;
  try {
    pattern = `${new URL(cfg.apiBaseUrl).origin}/*`;
  } catch {
    return false;
  }
  return chrome.permissions.request({ origins: [pattern] });
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

// ---- Content Radar capture ------------------------------------------------
//
// Runs in the active tab's page context (injected via chrome.scripting).
// Self-contained by necessity — executeScript serializes the function, so it
// can't close over anything in the popup. Returns the raw <link> feed data plus
// the page URL/title for normalizeDiscoveredFeeds to turn into candidates.
function collectFeedLinksInPage() {
  const links = Array.from(document.querySelectorAll('link[rel~="alternate"]')).map((el) => ({
    rel: el.getAttribute("rel") || "",
    type: el.getAttribute("type") || "",
    href: el.getAttribute("href") || "",
    title: el.getAttribute("title") || "",
  }));
  const og = document.querySelector('meta[property="og:site_name"]');
  return {
    links,
    baseUrl: location.href,
    pageTitle: document.title || "",
    siteName: og ? og.getAttribute("content") || "" : "",
  };
}

// Discover the RSS/Atom feed(s) advertised by the page in the active tab.
// Returns { feeds, siteTitle } or null when there's nothing to add (a
// restricted page, a non-http(s) tab, or a page with no feed link). Relies on
// activeTab — opening the popup is the user gesture that grants scripting on the
// current tab, so no broad host permission is needed.
async function discoverActiveTabFeeds() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    return null;
  }
  if (!tab?.id) return null;
  // tab.url is populated for the active tab under activeTab; when present, skip
  // pages that can't carry a feed we can add (chrome://, the web store, etc.).
  if (tab.url && !/^https?:/i.test(tab.url)) return null;

  let raw;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectFeedLinksInPage,
    });
    raw = res?.result;
  } catch {
    // executeScript rejects on restricted pages (chrome://, PDF viewer, the
    // Chrome Web Store) — treat as "no feed here" rather than an error.
    return null;
  }
  if (!raw || !/^https?:/i.test(raw.baseUrl || "")) return null;
  return normalizeDiscoveredFeeds(raw);
}

// The Content Radar section of the paired popup. Renders a placeholder
// synchronously and fills it in once discovery + the existing-source check
// resolve, so it never blocks the rest of the popup from painting.
function renderRadarSection() {
  const section = document.createElement("section");
  section.className = "radar";
  const head = document.createElement("div");
  head.className = "radar-head";
  head.textContent = "Content Radar";
  const body = document.createElement("div");
  body.className = "radar-body muted";
  body.textContent = "Checking this page…";
  section.append(head, body);
  void populateRadar(body);
  return section;
}

async function populateRadar(body) {
  const discovered = await discoverActiveTabFeeds();
  const feed = discovered?.feeds?.[0];
  if (!feed) {
    body.textContent = "No RSS/Atom feed found on this page.";
    return;
  }

  // Compare against the current radar so we offer "add" only for a new source —
  // the API doesn't dedupe by URL. A read failure here is non-fatal; we fall
  // through to the add button and let the add path surface any real error.
  const existing = await send({ type: "booked:radarFeeds" });
  const already = (existing?.feeds ?? []).some((f) => sameFeed(f.url, feed.url));

  body.classList.remove("muted");
  body.replaceChildren();

  const label = document.createElement("div");
  label.className = "radar-feed";
  const name = document.createElement("span");
  name.className = "radar-feed-name";
  name.textContent = feed.title;
  const url = document.createElement("span");
  url.className = "radar-feed-url";
  url.textContent = feed.url;
  label.append(name, url);
  body.appendChild(label);

  if (already) {
    const done = document.createElement("p");
    done.className = "radar-note";
    done.textContent = "Already on your radar.";
    body.appendChild(done);
    return;
  }

  const add = document.createElement("button");
  add.className = "primary";
  add.textContent = "Add to Content Radar";
  const status = document.createElement("p");
  status.hidden = true;
  add.addEventListener("click", async () => {
    add.disabled = true;
    add.textContent = "Adding…";
    const res = await send({
      type: "booked:addRadarFeed",
      url: feed.url,
      title: feed.title.slice(0, FEED_TITLE_MAX),
    });
    if (res?.error) {
      add.disabled = false;
      add.textContent = "Add to Content Radar";
      status.hidden = false;
      status.className = "radar-note error";
      status.textContent = res.error;
    } else {
      add.remove();
      status.hidden = false;
      status.className = "radar-note ok";
      status.textContent = "Added to your radar ✓";
    }
  });
  body.append(add, status);
}

// Dashboard URL is baked in at packaging time; an unfilled placeholder
// means a hand-packed zip without the substitution, in which case we
// keep the plain "Settings → Extension" text rather than render a broken
// link.
function dashboardSettingsUrl(cfg) {
  const base = cfg.dashboardBaseUrl;
  if (!base || base.startsWith("__")) return null;
  try {
    const url = new URL("/settings", base);
    url.searchParams.set("tab", "extension");
    return url.toString();
  } catch {
    return null;
  }
}

function timeAgo(iso) {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function formatMetrics(analytics) {
  if (!analytics) return "no engagement captured yet";
  const entries = Object.entries(analytics);
  if (!entries.length) return "no engagement captured yet";
  return entries.map(([k, v]) => `${k} ${Number(v).toLocaleString()}`).join(" · ");
}

function clear() {
  content.replaceChildren();
}

function renderSetup() {
  clear();
  const tpl = document.getElementById("setup-tpl").content.cloneNode(true);
  content.appendChild(tpl);
}

async function renderPair(error) {
  clear();
  const tpl = document.getElementById("pair-tpl").content.cloneNode(true);
  const input = tpl.querySelector("#pair-token");
  const btn = tpl.querySelector("#pair");
  const errEl = tpl.querySelector("#pair-error");
  const slot = tpl.querySelector("#pair-settings-slot");
  const settingsUrl = dashboardSettingsUrl(await getConfig());
  if (settingsUrl && slot) {
    const link = document.createElement("a");
    link.href = settingsUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Settings → Extension";
    slot.replaceChildren(link);
  }
  if (error) {
    errEl.textContent = error;
    errEl.hidden = false;
  }
  btn.addEventListener("click", async () => {
    const token = input.value.trim();
    if (!token) {
      errEl.textContent = "Paste a pairing code first.";
      errEl.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = "Pairing…";

    const granted = await ensureApiHostAccess();
    if (!granted) {
      void renderPair("Host access denied. The extension can't reach the Booked API without it.");
      return;
    }

    const status = await send({ type: "booked:pair", token });
    if (status?.error) {
      void renderPair(status.error);
    } else {
      render(status);
    }
  });
  content.appendChild(tpl);
}

function renderPaired(status) {
  clear();

  const account = document.createElement("div");
  account.className = "account";
  const label = document.createElement("span");
  label.className = "email";
  label.textContent = status.paired_at
    ? `Paired ${timeAgo(status.paired_at)}`
    : "Paired";
  const unpair = document.createElement("button");
  unpair.className = "link";
  unpair.textContent = "Unpair";
  unpair.addEventListener("click", async () => render(await send({ type: "booked:unpair" })));
  account.append(label, unpair);
  content.appendChild(account);

  const summary = document.createElement("p");
  summary.className = "muted";
  summary.textContent = `Syncing engagement on ${status.activeCount} tracked post${status.activeCount === 1 ? "" : "s"}.`;
  content.appendChild(summary);

  if (status.lastError) {
    const err = document.createElement("p");
    err.className = "error";
    err.textContent = status.lastError;
    content.appendChild(err);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const refresh = document.createElement("button");
  refresh.className = "primary";
  refresh.textContent = "Refresh list";
  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    refresh.textContent = "Refreshing…";
    render(await send({ type: "booked:refreshFeed" }));
  });
  actions.appendChild(refresh);
  content.appendChild(actions);

  content.appendChild(renderRadarSection());

  if (status.posts?.length) {
    const scroll = document.createElement("div");
    scroll.className = "posts-scroll";

    // Group the flat feed by platform so each platform's posts sit under a
    // single heading, rather than every row repeating its own platform chip.
    const groups = new Map();
    for (const post of status.posts) {
      const key = post.platform || "other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(post);
    }

    // Platforms alphabetized for a stable order; posts within each platform
    // sorted by campaign name so a campaign stays easy to find.
    for (const platform of [...groups.keys()].sort()) {
      const posts = groups.get(platform);
      posts.sort((a, b) => (a.campaign_name || a.url).localeCompare(b.campaign_name || b.url));

      const group = document.createElement("section");
      group.className = "platform-group";

      const head = document.createElement("div");
      head.className = "platform-head";
      const name = document.createElement("span");
      name.textContent = platform;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(posts.length);
      head.append(name, count);
      group.appendChild(head);

      const list = document.createElement("ul");
      list.className = "posts";
      for (const post of posts) {
        const li = document.createElement("li");
        const row = document.createElement("div");
        row.className = "row";
        const link = document.createElement("a");
        link.href = post.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = post.campaign_name || post.url;
        row.appendChild(link);

        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = `${formatMetrics(post.analytics)} — fetched ${timeAgo(post.last_fetched)}`;

        li.append(row, meta);
        list.appendChild(li);
      }
      group.appendChild(list);
      scroll.appendChild(group);
    }
    content.appendChild(scroll);
  }

  syncedEl.textContent = status.syncedThisSession
    ? `${status.syncedThisSession} synced this session`
    : "";
}

function render(status) {
  if (!status || !status.configured) {
    renderSetup();
    return;
  }
  if (!status.paired) {
    void renderPair();
    return;
  }
  renderPaired(status);
}

(async function start() {
  render(await send({ type: "booked:status" }));
})();
