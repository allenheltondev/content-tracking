// Popup UI. All real work lives in the background service worker; the
// popup just renders status, captures the pairing-code paste, and
// forwards button intents.

import { getConfig } from "./config.js";

const content = document.getElementById("content");
const syncedEl = document.getElementById("synced");

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

function renderPair(error) {
  clear();
  const tpl = document.getElementById("pair-tpl").content.cloneNode(true);
  const input = tpl.querySelector("#pair-token");
  const btn = tpl.querySelector("#pair");
  const errEl = tpl.querySelector("#pair-error");
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
      renderPair("Host access denied. The extension can't reach the Booked API without it.");
      return;
    }

    const status = await send({ type: "booked:pair", token });
    if (status?.error) {
      renderPair(status.error);
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
  summary.textContent = `${status.activeCount} post${status.activeCount === 1 ? "" : "s"} on active campaigns being tracked.`;
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

  if (status.posts?.length) {
    const list = document.createElement("ul");
    list.className = "posts";
    for (const post of status.posts) {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "row";
      const platform = document.createElement("span");
      platform.className = "platform";
      platform.textContent = post.platform;
      const link = document.createElement("a");
      link.href = post.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = post.campaign_name || post.url;
      row.append(platform, link);

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${formatMetrics(post.analytics)} — fetched ${timeAgo(post.last_fetched)}`;

      li.append(row, meta);
      list.appendChild(li);
    }
    content.appendChild(list);
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
    renderPair();
    return;
  }
  renderPaired(status);
}

(async function start() {
  render(await send({ type: "booked:status" }));
})();
