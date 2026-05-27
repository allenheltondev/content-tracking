// Popup UI. All real work lives in the background service worker; the popup
// just renders status and forwards button intents (sign in/out, refresh).

const content = document.getElementById("content");
const syncedEl = document.getElementById("synced");

document.getElementById("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function send(type) {
  return chrome.runtime.sendMessage({ type });
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
  tpl.querySelector("#open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  content.appendChild(tpl);
}

function renderSignIn(error) {
  clear();
  const tpl = document.getElementById("signin-tpl").content.cloneNode(true);
  const btn = tpl.querySelector("#signin");
  const errEl = tpl.querySelector("#signin-error");
  if (error) {
    errEl.textContent = error;
    errEl.hidden = false;
  }
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Opening sign-in…";
    const status = await send("booked:signIn");
    if (status?.error) {
      renderSignIn(status.error);
    } else {
      render(status);
    }
  });
  content.appendChild(tpl);
}

function renderSignedIn(status) {
  clear();

  const account = document.createElement("div");
  account.className = "account";
  const email = document.createElement("span");
  email.className = "email";
  email.textContent = status.email || "Signed in";
  const signOut = document.createElement("button");
  signOut.className = "link";
  signOut.textContent = "Sign out";
  signOut.addEventListener("click", async () => render(await send("booked:signOut")));
  account.append(email, signOut);
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
    render(await send("booked:refreshFeed"));
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
  if (!status) {
    renderSignIn();
    return;
  }
  if (!status.configured) {
    renderSetup();
    return;
  }
  if (!status.signedIn) {
    renderSignIn();
    return;
  }
  renderSignedIn(status);
}

(async function start() {
  render(await send("booked:status"));
})();
