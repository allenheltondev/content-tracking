// Injects Booked refresh controls onto the dashboard's campaign detail page:
// a "Refresh Stats" button in the Promotion tab's actions slot, and a compact
// refresh icon on the Analytics tab's "Needs refresh" tiles. Both ask the
// background worker to re-scrape every tracked post in this campaign whose
// analytics weren't fetched today; the scrape-and-close pipeline (handleScraped
// / handleCaptured) closes each tab once its post syncs.
//
// Each control anchors on a `data-booked-slot=...` element the dashboard
// renders. Those slots mount/unmount with their tab, so a MutationObserver
// re-runs mount whenever a slot enters the DOM.

(function () {
  let busy = false;

  // Mounted controls, split by kind so a busy-state change can re-render every
  // one of them in lockstep without re-querying the DOM.
  const textButtons = new Set();
  const iconButtons = new Set();

  // Heroicons "arrow-path" (solid, 20x20). Static markup — no injection risk.
  const REFRESH_ICON_SVG =
    '<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" />' +
    '</svg>';

  function currentCampaignId() {
    const m = /\/campaigns\/([^/?#]+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function renderAll() {
    for (const b of textButtons) {
      b.disabled = busy;
      b.textContent = busy ? "Refreshing…" : "Refresh Stats";
    }
    for (const b of iconButtons) {
      b.disabled = busy;
      b.classList.toggle("opacity-60", busy);
    }
  }

  async function onClick() {
    const cid = currentCampaignId();
    if (!cid || busy) return;
    busy = true;
    renderAll();
    try {
      await chrome.runtime.sendMessage({
        type: "booked:refreshStale",
        campaignId: cid,
      });
    } catch (err) {
      console.warn("[booked] refreshStale failed:", err);
    } finally {
      // Background scrapes run in their own tabs and sync on their own. Hold
      // the busy state briefly so the user sees acknowledgement even if the
      // first sync lands instantly.
      setTimeout(() => {
        busy = false;
        renderAll();
      }, 4000);
    }
  }

  function buildButton(kind) {
    const btn = document.createElement("button");
    btn.type = "button";
    if (kind === "icon") {
      // Compact, square icon button that sits in the corner of the tile.
      btn.className = "btn-secondary !p-1.5 leading-none";
      btn.title = "Refresh stats";
      btn.setAttribute("aria-label", "Refresh stats");
      btn.innerHTML = REFRESH_ICON_SVG;
    } else {
      // Match the styling of the sibling "+ Add post" / "Install extension"
      // buttons in CampaignDetail.tsx.
      btn.className = "btn-secondary py-1 px-2 text-sm";
    }
    btn.addEventListener("click", () => void onClick());
    return btn;
  }

  // Find every slot of each kind, inject our control once (idempotent via the
  // per-kind marker attribute), and re-render so busy state is current.
  function mount() {
    textButtons.clear();
    iconButtons.clear();

    document
      .querySelectorAll('[data-booked-slot="social-posts-actions"]')
      .forEach((slot) => {
        let btn = slot.querySelector('[data-booked-refresh-stale="1"]');
        if (!btn) {
          btn = buildButton("text");
          btn.setAttribute("data-booked-refresh-stale", "1");
          // Prepend so it sits to the left of the existing buttons.
          slot.insertBefore(btn, slot.firstChild);
        }
        textButtons.add(btn);
      });

    document
      .querySelectorAll('[data-booked-slot="needs-refresh"]')
      .forEach((slot) => {
        let btn = slot.querySelector('[data-booked-refresh-icon="1"]');
        if (!btn) {
          btn = buildButton("icon");
          btn.setAttribute("data-booked-refresh-icon", "1");
          slot.appendChild(btn);
        }
        iconButtons.add(btn);
      });

    renderAll();
  }

  // The slots swap in and out on tab switches and SPA navigations, so we watch
  // document.body for them. The catch is that mount() writes into that same
  // observed subtree (it inserts controls and sets their content), so a naive
  // observer re-fires on its own writes and loops until the tab freezes. We
  // defend two ways: affectsSlot ignores mutations that don't add or remove a
  // slot itself, and safeMount() disconnects the observer for the duration of
  // mount() so its writes can never feed back in.
  const SLOT_SELECTOR =
    '[data-booked-slot="social-posts-actions"],[data-booked-slot="needs-refresh"]';
  function affectsSlot(nodes) {
    for (const node of nodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches?.(SLOT_SELECTOR)) return true;
      if (node.querySelector?.(SLOT_SELECTOR)) return true;
    }
    return false;
  }

  const OBSERVE_OPTS = { childList: true, subtree: true };
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      if (affectsSlot(r.addedNodes) || affectsSlot(r.removedNodes)) {
        safeMount();
        return;
      }
    }
  });

  // Run mount() with the observer disconnected so none of its DOM writes can
  // re-trigger the observer. takeRecords() drops the mutations those writes
  // queued while disconnected so they aren't delivered on reconnect.
  function safeMount() {
    obs.disconnect();
    try {
      mount();
    } finally {
      obs.takeRecords();
      obs.observe(document.body, OBSERVE_OPTS);
    }
  }

  obs.observe(document.body, OBSERVE_OPTS);

  function init() {
    safeMount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
  } else {
    void init();
  }
})();
