// Injects a "Refresh stale" button onto the Booked dashboard's campaign
// detail page. When clicked, the button asks the background worker to
// re-scrape every LinkedIn post in this campaign whose analytics weren't
// fetched today. Background reuses the auto-scrape pipeline so each tab
// opens, scrapes, syncs, and closes on its own.
//
// Anchors on a `data-booked-slot="social-posts-actions"` element rendered
// by the dashboard's Promotion tab. The slot mounts/unmounts with the tab,
// so a MutationObserver re-runs mount whenever the slot enters the DOM.

(function () {
  const FEED_KEY = "booked_feed";

  let feed = [];
  let currentBtn = null;
  let busy = false;

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function currentCampaignId() {
    const m = /\/campaigns\/([^/?#]+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  // Every tracked platform refreshes through the same background pipeline:
  // LinkedIn via the analytics-page DOM scrape, Twitter/Instagram via the
  // MAIN-world API interceptor on the post URL. The background decides
  // which URL to open per platform.
  function stalePostsForCampaign() {
    const cid = currentCampaignId();
    if (!cid) return [];
    const today = todayKey();
    return feed.filter((p) => {
      if (p.campaign_id !== cid) return false;
      if (!p.last_fetched) return true;
      return String(p.last_fetched).slice(0, 10) !== today;
    });
  }

  async function loadFeed() {
    const data = await chrome.storage.local.get(FEED_KEY);
    feed = (data[FEED_KEY] && data[FEED_KEY].posts) || [];
  }

  function findSlot() {
    return document.querySelector('[data-booked-slot="social-posts-actions"]');
  }

  function renderButton(btn) {
    if (busy) {
      btn.textContent = "Refreshing…";
      btn.disabled = true;
      return;
    }
    const count = stalePostsForCampaign().length;
    btn.disabled = count === 0;
    btn.textContent = count === 0
      ? "Analytics up to date"
      : `Refresh stale (${count})`;
  }

  async function onClick() {
    const cid = currentCampaignId();
    if (!cid || busy) return;
    busy = true;
    if (currentBtn) renderButton(currentBtn);
    try {
      await chrome.runtime.sendMessage({
        type: "booked:refreshStale",
        campaignId: cid,
      });
    } catch (err) {
      console.warn("[booked] refreshStale failed:", err);
    } finally {
      // Background scrapes update the feed in storage; storage.onChanged
      // re-renders the count. Hold the busy state briefly so the user
      // sees acknowledgement even if the first sync lands instantly.
      setTimeout(() => {
        busy = false;
        if (currentBtn) renderButton(currentBtn);
      }, 4000);
    }
  }

  function buildButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.bookedRefreshStale = "1";
    // Match the styling of the sibling "+ Add post" / "Install extension"
    // buttons in CampaignDetail.tsx.
    btn.className = "btn-secondary py-1 px-2 text-sm";
    btn.addEventListener("click", () => void onClick());
    return btn;
  }

  function mount() {
    const slot = findSlot();
    if (!slot) {
      currentBtn = null;
      return;
    }
    const existing = slot.querySelector('[data-booked-refresh-stale="1"]');
    if (existing) {
      currentBtn = existing;
    } else {
      currentBtn = buildButton();
      // Prepend so it sits to the left of the existing buttons.
      slot.insertBefore(currentBtn, slot.firstChild);
    }
    renderButton(currentBtn);
  }

  // Tab switches and SPA navigations swap the slot in and out. Only react
  // when the slot itself enters or leaves the DOM — reacting to any subtree
  // mutation would loop, because mount() sets the button's textContent,
  // and that childList mutation would re-fire the observer indefinitely.
  const SLOT_SELECTOR = '[data-booked-slot="social-posts-actions"]';
  function affectsSlot(nodes) {
    for (const node of nodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches?.(SLOT_SELECTOR)) return true;
      if (node.querySelector?.(SLOT_SELECTOR)) return true;
    }
    return false;
  }
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      if (affectsSlot(r.addedNodes) || affectsSlot(r.removedNodes)) {
        mount();
        return;
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes[FEED_KEY]) return;
    feed = (changes[FEED_KEY].newValue && changes[FEED_KEY].newValue.posts) || [];
    if (currentBtn) renderButton(currentBtn);
  });

  // Cold-start the service worker so its feed refresh runs. The
  // storage.onChanged listener above picks up the result.
  function nudgeBackground() {
    try {
      chrome.runtime.sendMessage({ type: "booked:status" }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  async function init() {
    await loadFeed();
    mount();
    nudgeBackground();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
  } else {
    void init();
  }
})();
