// Injects a "Booked" item into the host site's own navigation (X's left
// rail, LinkedIn's top nav) listing the social posts we're monitoring on
// this platform. Clicking a menu entry navigates to that post's URL so
// the MAIN-world interceptor (inject.js) sees its analytics traffic. A
// red badge on the button counts posts we haven't visited yet today.
//
// ISOLATED world, document_idle. Skips Instagram. Tolerates SPA nav by
// re-mounting whenever the host's nav element is swapped out.

(function () {
  function detectPlatform() {
    const host = location.hostname.replace(/^www\./, "");
    if (host === "x.com" || host === "twitter.com" ||
        host.endsWith(".x.com") || host.endsWith(".twitter.com")) {
      return "twitter";
    }
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
    if (host === "bsky.app" || host.endsWith(".bsky.app")) return "bluesky";
    if (host === "medium.com" || host.endsWith(".medium.com")) return "medium";
    if (host === "dev.to" || host.endsWith(".dev.to")) return "devto";
    return null;
  }

  const platform = detectPlatform();
  if (!platform) return;

  const FEED_KEY = "booked_feed";
  const VISITED_KEY = "booked_visited";
  const VISITED_TTL_DAYS = 7;

  let posts = [];
  let visitedMap = {};
  let buttonEl = null;
  let menuHost = null;
  let menuShadow = null;
  let menuOpen = false;
  let mountWatchTimer = null;

  // ---- state ----------------------------------------------------------------

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function isVisitedToday(postId) {
    return visitedMap[postId] === todayKey();
  }

  function unvisitedCount() {
    return posts.filter((p) => !isVisitedToday(p.post_id)).length;
  }

  function pruneVisited(map) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - VISITED_TTL_DAYS);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === "string" && v >= cutoffKey) out[k] = v;
    }
    return out;
  }

  async function loadState() {
    const data = await chrome.storage.local.get([FEED_KEY, VISITED_KEY]);
    const feed = (data[FEED_KEY] && data[FEED_KEY].posts) || [];
    posts = feed.filter((p) => p.platform === platform);
    visitedMap = pruneVisited(data[VISITED_KEY] || {});
  }

  async function markVisited(postId) {
    visitedMap = { ...visitedMap, [postId]: todayKey() };
    await chrome.storage.local.set({ [VISITED_KEY]: visitedMap });
  }

  // LinkedIn's post pages are server-rendered SDUI with no clean JSON
  // API to capture; the per-post analytics page exposes the counts in
  // the DOM instead. Only deep-link there when the stored URL contains
  // an explicit activity URN — slug URLs (linkedin.com/posts/...) embed
  // share/ugcPost ids whose mapping to the activity URN we can't derive
  // without scraping the post page first. For those, send the user to
  // the post URL as-is; posts-linkedin.js resolves the activity URN on
  // arrival and background opens an analytics scrape tab from there.
  function destinationUrl(post) {
    if (post.platform === "linkedin") {
      const m = /urn:li:activity:(\d+)/.exec(post.url);
      return m
        ? `https://www.linkedin.com/analytics/post-summary/urn:li:activity:${m[1]}/`
        : post.url;
    }
    // Content platforms expose stats on a dedicated page the interceptor
    // captures: Medium's per-post stats detail, dev.to's article /stats.
    // Send the user straight there so a menu click both opens the stats
    // view and triggers a fresh sync.
    if (post.platform === "medium") {
      const m =
        /\/(?:p|post)\/([0-9a-f]+)/i.exec(post.url) ||
        /-([0-9a-f]{6,})(?:[/?#]|$)/i.exec(post.url);
      return m ? `https://medium.com/me/stats/post/${m[1].toLowerCase()}` : post.url;
    }
    if (post.platform === "devto") {
      try {
        const u = new URL(post.url);
        u.search = "";
        u.hash = "";
        u.pathname = u.pathname.replace(/\/$/, "").replace(/\/stats$/, "") + "/stats";
        return u.toString();
      } catch {
        return post.url;
      }
    }
    return post.url;
  }

  function normalizeUrl(u) {
    try {
      const url = new URL(u);
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, "").toLowerCase();
    } catch {
      return (u || "").toLowerCase();
    }
  }

  function autoMarkIfOnTrackedPost() {
    const here = normalizeUrl(location.href);
    const match = posts.find((p) => normalizeUrl(p.url) === here);
    if (match && !isVisitedToday(match.post_id)) void markVisited(match.post_id);
  }

  // ---- platform-specific injection -----------------------------------------

  const ICON_SVG = `
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="4" y="13" width="3.5" height="7" rx="0.5"></rect>
      <rect x="10.25" y="9" width="3.5" height="11" rx="0.5"></rect>
      <rect x="16.5" y="5" width="3.5" height="15" rx="0.5"></rect>
    </svg>`;

  // Content platforms (Medium, dev.to) have no stable host nav to clone an
  // item into, and their DOM rotates as readily as LinkedIn's. Inject a
  // self-styled floating button instead — it depends on nothing but the page
  // <body>, so a platform redesign can't strand it. It opens the same
  // shadow-DOM menu the cloned nav items use.
  function buildFloatingButton(onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.bookedTaskbar = "1";
    btn.setAttribute("aria-label", "Booked");
    btn.style.cssText = [
      "position:fixed",
      "bottom:20px",
      "right:20px",
      "z-index:2147483646",
      "display:flex",
      "align-items:center",
      "gap:8px",
      "padding:10px 14px",
      "border:0",
      "border-radius:9999px",
      "background:#2563eb",
      "color:#fff",
      "font:600 14px/1 system-ui,-apple-system,'Segoe UI',sans-serif",
      "box-shadow:0 4px 14px rgba(0,0,0,0.25)",
      "cursor:pointer",
    ].join(";");
    btn.innerHTML = `
      <span data-booked-icon-wrap style="position:relative;display:inline-flex;width:20px;height:20px;align-items:center;justify-content:center;">
        ${ICON_SVG}
        <span data-booked-badge style="${BADGE_STYLE}"></span>
      </span>
      <span>Booked</span>`;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      onClick(btn);
    });
    return btn;
  }

  const PLATFORM_TARGETS = {
    twitter: {
      navSelector: 'nav[aria-label="Primary"]',
      buildButton(onClick) {
        const a = document.createElement("a");
        a.href = "javascript:void(0)";
        a.setAttribute("role", "link");
        a.setAttribute("aria-label", "Booked");
        a.dataset.bookedTaskbar = "1";
        a.style.cssText = [
          "display:flex",
          "align-items:center",
          "gap:20px",
          "padding:12px",
          "margin:4px 0",
          // X's nav font isn't set on the <nav>, so `font:inherit` falls
          // through to the browser default (serif on most setups). Pin
          // Chirp explicitly with X's full system fallback chain.
          'font-family:TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
          "font-size:20px",
          "color:inherit",
          "text-decoration:none",
          "border-radius:9999px",
          "cursor:pointer",
          "position:relative",
        ].join(";");
        a.innerHTML = `
          <span data-booked-icon-wrap style="position:relative;display:inline-flex;width:26px;height:26px;align-items:center;justify-content:center;">
            ${ICON_SVG}
            <span data-booked-badge style="${BADGE_STYLE}"></span>
          </span>
          <span style="font-weight:400">Booked</span>
        `;
        a.addEventListener("mouseenter", () => {
          a.style.background = "rgba(231,233,234,0.1)";
        });
        a.addEventListener("mouseleave", () => {
          a.style.background = "";
        });
        a.addEventListener("click", (e) => {
          e.preventDefault();
          onClick(a);
        });
        return a;
      },
      insert(nav, el) {
        // Drop in as the last item so it sits below "Premium"/"Profile".
        nav.appendChild(el);
      },
    },
    linkedin: {
      // LinkedIn rotates both the componentkey and the hashed utility classes
      // on every nav redesign, so neither is a safe anchor (the componentkey
      // that worked in May 2026 was gone by June). The primary nav's product
      // destinations — /mynetwork, /notifications/, /messaging/, /jobs/ — are
      // stable across redesigns, so find one of those links and climb to the
      // <ul> that holds the nav items. We then clone a sibling <li> so our
      // button inherits whatever styling the current build hands the others.
      // The old componentkey selector stays as a fast path for builds that
      // still expose it.
      findNav() {
        const byKey = document.querySelector(
          'nav[componentkey="primaryNavLinksComponentRef"] ul',
        );
        if (byKey) return byKey;
        const PRIMARY_HREFS = ["/mynetwork", "/notifications/", "/messaging/", "/jobs/"];
        for (const href of PRIMARY_HREFS) {
          const link = document.querySelector(`nav a[href*="${href}"]`);
          const ul = link && link.closest("ul");
          if (ul) return ul;
        }
        return null;
      },
      buildButton(onClick, ul) {
        const sample = ul && ul.querySelector("li");
        const li = sample
          ? sample.cloneNode(true)
          : document.createElement("li");
        li.dataset.bookedTaskbar = "1";
        li.removeAttribute("componentkey");

        // Drop existing listeners by cloning the actionable element, then
        // mutate the clone into our Booked button.
        const original = li.querySelector("button, a");
        const action = original ? original.cloneNode(true) : document.createElement("button");
        if (original) original.replaceWith(action);
        else li.appendChild(action);

        if (action.tagName === "A") action.removeAttribute("href");
        if (action.tagName === "BUTTON") action.type = "button";
        action.removeAttribute("aria-current");
        action.setAttribute("aria-label", "Booked");

        // Replace the icon: keep LinkedIn's wrapper span (and its classes,
        // which carry the sizing/color rules), swap the svg, attach badge.
        const existingSvg = action.querySelector("svg");
        const iconWrap = existingSvg ? existingSvg.parentElement : action;
        if (existingSvg) {
          iconWrap.innerHTML = ICON_SVG;
        } else {
          // No sibling to clone from — fall back to inline-styled markup.
          action.style.cssText = [
            "background:transparent",
            "border:0",
            "cursor:pointer",
            "padding:4px 12px",
            "display:flex",
            "flex-direction:column",
            "align-items:center",
            "gap:2px",
            "font:inherit",
            "font-size:12px",
            "min-width:80px",
          ].join(";");
          action.innerHTML = `<span data-booked-icon-wrap style="position:relative;display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center;">${ICON_SVG}</span><span>Booked</span>`;
        }
        const badge = document.createElement("span");
        badge.setAttribute("data-booked-badge", "");
        badge.style.cssText = BADGE_STYLE;
        const finalIconWrap = action.querySelector("svg")?.parentElement;
        if (finalIconWrap) {
          finalIconWrap.style.position = finalIconWrap.style.position || "relative";
          finalIconWrap.appendChild(badge);
        }

        // Replace the label text. The label is the deepest text-only span;
        // walking from the leaves finds it regardless of nesting depth.
        const labelSpan = [...action.querySelectorAll("span")]
          .reverse()
          .find((s) => s.children.length === 0 && s.textContent.trim().length > 0);
        if (labelSpan) labelSpan.textContent = "Booked";

        action.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick(action);
        });

        return li;
      },
      insert(ul, el) {
        ul.appendChild(el);
      },
    },
    bluesky: {
      // bsky.app is a React SPA with no stable nav to clone a real item into,
      // so use the same self-styled floating button the content platforms do.
      floating: true,
      buildButton: buildFloatingButton,
      insert(host, el) {
        host.appendChild(el);
      },
    },
    medium: {
      floating: true,
      buildButton: buildFloatingButton,
      insert(host, el) {
        host.appendChild(el);
      },
    },
    devto: {
      floating: true,
      buildButton: buildFloatingButton,
      insert(host, el) {
        host.appendChild(el);
      },
    },
  };

  const BADGE_STYLE = [
    "position:absolute",
    "top:-4px",
    "right:-8px",
    "min-width:16px",
    "height:16px",
    "padding:0 4px",
    "border-radius:9999px",
    "background:#dc2626",
    "color:#fff",
    "font:600 10px/16px system-ui,sans-serif",
    "text-align:center",
    "display:none",
    "box-sizing:border-box",
  ].join(";");

  // ---- menu (popover) -------------------------------------------------------

  function ensureMenuHost() {
    if (menuHost && document.contains(menuHost)) return;
    menuHost = document.createElement("div");
    menuHost.id = "booked-taskbar-menu-host";
    menuHost.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647;";
    menuShadow = menuHost.attachShadow({ mode: "closed" });
    menuShadow.innerHTML = `
      <style>
        :host { all: initial; }
        .menu {
          position: fixed;
          min-width: 300px;
          max-width: 360px;
          max-height: 480px;
          overflow-y: auto;
          background: #fff;
          color: #111827;
          border-radius: 12px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08);
          border: 1px solid rgba(0,0,0,0.08);
          font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
          padding: 6px;
        }
        @media (prefers-color-scheme: dark) {
          .menu { background:#1f2937; color:#f3f4f6; border-color:rgba(255,255,255,0.08); }
        }
        .menu header {
          padding: 8px 10px 10px;
          font-weight: 600;
          font-size: 13px;
          color: inherit;
          opacity: 0.85;
        }
        .menu .empty {
          padding: 8px 10px 14px;
          font-size: 13px;
          opacity: 0.7;
        }
        .menu ul { list-style:none; padding:0; margin:0; }
        .menu li a {
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 8px 10px;
          border-radius: 8px;
          text-decoration: none;
          color: inherit;
          cursor: pointer;
        }
        .menu li a:hover { background: rgba(37,99,235,0.08); }
        .menu li.visited a { opacity: 0.55; }
        .menu li a .name { font-weight: 600; font-size: 14px; }
        .menu li a .url {
          font-size: 12px; opacity: 0.7;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .menu li.visited a .name::after {
          content: " · visited today";
          font-weight: 400; font-size: 11px; opacity: 0.7;
        }
        .menu footer {
          padding: 8px 10px 4px;
          font-size: 11px; opacity: 0.6;
          border-top: 1px solid rgba(0,0,0,0.06);
          margin-top: 4px;
        }
        @media (prefers-color-scheme: dark) {
          .menu footer { border-top-color: rgba(255,255,255,0.06); }
          .menu li a:hover { background: rgba(96,165,250,0.15); }
        }
      </style>
      <div class="menu" role="menu" hidden>
        <header data-booked-menu-title>Booked posts</header>
        <ul data-booked-menu-list></ul>
        <div class="empty" data-booked-menu-empty hidden></div>
        <footer data-booked-menu-footer></footer>
      </div>`;
    (document.body || document.documentElement).appendChild(menuHost);
  }

  function positionMenu(anchor) {
    const menu = menuShadow.querySelector(".menu");
    const rect = anchor.getBoundingClientRect();
    menu.hidden = false;
    // Measure after un-hiding, then place.
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const margin = 8;
    let top, left;
    if (PLATFORM_TARGETS[platform].floating) {
      // Floating button sits at the bottom-right; open the menu just above
      // it, right-aligned to the button.
      top = Math.max(margin, rect.top - mh - 6);
      left = Math.min(window.innerWidth - mw - margin, Math.max(margin, rect.right - mw));
    } else if (platform === "linkedin") {
      // Below the header nav, right-aligned to the anchor.
      top = Math.min(window.innerHeight - mh - margin, rect.bottom + 6);
      left = Math.min(window.innerWidth - mw - margin, Math.max(margin, rect.right - mw));
    } else {
      // Right of the X rail, vertically centered with the anchor.
      top = Math.min(window.innerHeight - mh - margin, Math.max(margin, rect.top));
      left = Math.min(window.innerWidth - mw - margin, rect.right + 6);
    }
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
  }

  function openMenu(anchor) {
    ensureMenuHost();
    renderMenu();
    positionMenu(anchor);
    menuOpen = true;
    setTimeout(() => document.addEventListener("click", outsideClick, true), 0);
  }

  function closeMenu() {
    menuOpen = false;
    document.removeEventListener("click", outsideClick, true);
    if (menuShadow) {
      const menu = menuShadow.querySelector(".menu");
      if (menu) menu.hidden = true;
    }
  }

  function outsideClick(e) {
    if (!menuHost || !buttonEl) return;
    if (menuHost.contains(e.target) || buttonEl.contains(e.target)) return;
    closeMenu();
  }

  function toggleMenu(anchor) {
    if (menuOpen) closeMenu();
    else openMenu(anchor);
  }

  function renderMenu() {
    if (!menuShadow) return;
    const today = todayKey();
    const list = menuShadow.querySelector("[data-booked-menu-list]");
    const empty = menuShadow.querySelector("[data-booked-menu-empty]");
    const footer = menuShadow.querySelector("[data-booked-menu-footer]");
    list.innerHTML = "";
    if (!posts.length) {
      list.hidden = true;
      empty.hidden = false;
      empty.textContent = "No posts being monitored on this platform.";
      footer.textContent = "";
      return;
    }
    list.hidden = false;
    empty.hidden = true;
    // Show unvisited first, then visited, both alphabetized by campaign.
    const sorted = [...posts].sort((a, b) => {
      const aVisited = isVisitedToday(a.post_id) ? 1 : 0;
      const bVisited = isVisitedToday(b.post_id) ? 1 : 0;
      if (aVisited !== bVisited) return aVisited - bVisited;
      return (a.campaign_name || "").localeCompare(b.campaign_name || "");
    });
    for (const post of sorted) {
      const li = document.createElement("li");
      if (isVisitedToday(post.post_id)) li.className = "visited";
      const a = document.createElement("a");
      a.href = post.url;
      a.setAttribute("role", "menuitem");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = post.campaign_name || "(unnamed campaign)";
      const url = document.createElement("span");
      url.className = "url";
      url.textContent = post.url;
      a.append(name, url);
      const destination = destinationUrl(post);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        closeMenu();
        void markVisited(post.post_id).finally(() => {
          window.location.href = destination;
        });
      });
      li.appendChild(a);
      list.appendChild(li);
    }
    const unvisited = unvisitedCount();
    footer.textContent = `${unvisited} of ${posts.length} unvisited today`;
  }

  // ---- button mount / render ------------------------------------------------

  function findNav() {
    const target = PLATFORM_TARGETS[platform];
    if (target.floating) return document.body || document.documentElement;
    if (typeof target.findNav === "function") return target.findNav();
    return document.querySelector(target.navSelector);
  }

  // Mount/unmount the button to match current state. The cloned nav items on
  // X/LinkedIn always show; the floating content-platform button only shows
  // when there's something to list, so it doesn't sit on every Medium page
  // you read when nothing is tracked.
  function ensureMounted() {
    const target = PLATFORM_TARGETS[platform];
    if (target.floating && !posts.length) {
      if (buttonEl && buttonEl.parentNode) buttonEl.remove();
      buttonEl = null;
      if (menuOpen) closeMenu();
      return;
    }
    if (!buttonEl || !document.contains(buttonEl)) mount();
  }

  function mount() {
    const nav = findNav();
    if (!nav) return false;
    const existing = nav.querySelector('[data-booked-taskbar="1"]');
    if (existing) {
      buttonEl = existing;
    } else {
      buttonEl = PLATFORM_TARGETS[platform].buildButton(toggleMenu, nav);
      PLATFORM_TARGETS[platform].insert(nav, buttonEl);
    }
    renderButton();
    return true;
  }

  function renderButton() {
    if (!buttonEl) return;
    const badge = buttonEl.querySelector("[data-booked-badge]");
    if (!badge) return;
    const count = unvisitedCount();
    if (count > 0) {
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.style.display = "inline-flex";
      badge.style.alignItems = "center";
      badge.style.justifyContent = "center";
    } else {
      badge.style.display = "none";
    }
  }

  function render() {
    renderButton();
    if (menuOpen) renderMenu();
  }

  // SPA navigations on X/LinkedIn occasionally swap out the nav element.
  // A 2s poll is cheap and avoids a deep MutationObserver subtree watch.
  function watchForNavSwap() {
    if (mountWatchTimer) return;
    mountWatchTimer = setInterval(ensureMounted, 2000);
  }

  // ---- lifecycle ------------------------------------------------------------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let changed = false;
    if (changes[FEED_KEY]) {
      const feed = (changes[FEED_KEY].newValue && changes[FEED_KEY].newValue.posts) || [];
      posts = feed.filter((p) => p.platform === platform);
      changed = true;
    }
    if (changes[VISITED_KEY]) {
      visitedMap = pruneVisited(changes[VISITED_KEY].newValue || {});
      changed = true;
    }
    if (changed) {
      ensureMounted();
      render();
    }
  });

  // Wake the background worker so it ensures the feed is fresh. The
  // service worker may have been dormant; any sendMessage cold-starts it
  // and runs its init(), which refreshes the feed if its TTL has passed.
  // We don't await the response — the storage.onChanged listener will
  // pick up any update.
  function nudgeBackground() {
    try {
      chrome.runtime.sendMessage({ type: "booked:status" }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  async function init() {
    await loadState();
    autoMarkIfOnTrackedPost();
    ensureMounted();
    watchForNavSwap();
    nudgeBackground();
  }

  const startInit = () => init().catch((err) => console.warn("[booked] taskbar init failed:", err));
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startInit, { once: true });
  } else {
    startInit();
  }
})();
