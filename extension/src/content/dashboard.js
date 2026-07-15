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

  // ---- automatic pairing ----------------------------------------------------
  //
  // When the Settings → Extension page mints a pairing code it renders the
  // token into a hidden slot (data-booked-slot="pairing-token") plus a status
  // slot (data-booked-slot="pairing-status"). If this browser has the extension
  // installed but not yet paired, we read the token and pair automatically, so
  // the user never has to copy it into the popup. We only ever configure a
  // browser that has no pairing yet — an already-paired browser is left alone,
  // and the visible code still works for setting up a *different* browser.

  const PAIR_TOKEN_SELECTOR = '[data-booked-slot="pairing-token"]';
  const PAIR_STATUS_SELECTOR = '[data-booked-slot="pairing-status"]';
  const PAIR_COLORS = { pending: "#6b7280", info: "#6b7280", ok: "#16a34a", error: "#dc2626" };

  // Tokens we've already acted on, so a dialog re-render or a double observer
  // fire can't pair twice or repeat the status.
  const handledTokens = new Set();

  function writePairStatus(text, kind) {
    const slot = document.querySelector(PAIR_STATUS_SELECTOR);
    if (!slot) return;
    slot.textContent = text;
    slot.hidden = false;
    slot.style.color = PAIR_COLORS[kind] || "";
    slot.setAttribute("data-booked-pair-state", kind);
  }

  async function maybeAutoPair() {
    const el = document.querySelector(PAIR_TOKEN_SELECTOR);
    const token = el && el.getAttribute("data-booked-token");
    if (!token || handledTokens.has(token)) return;

    let status;
    try {
      status = await chrome.runtime.sendMessage({ type: "booked:status" });
    } catch {
      // Background unreachable (extension disabled / updating). Leave the
      // manual copy-paste path untouched.
      return;
    }
    if (!status) return;

    if (status.paired) {
      // Already set up here; don't disturb it. The visible code still lets the
      // user pair another browser.
      handledTokens.add(token);
      writePairStatus("This browser is already paired with Booked.", "info");
      return;
    }

    handledTokens.add(token);
    writePairStatus("Pairing this browser automatically…", "pending");

    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "booked:pair", token });
    } catch {
      handledTokens.delete(token); // allow a retry if the worker was mid-restart
      writePairStatus("Couldn't reach the extension. Paste the code into the popup to pair.", "error");
      return;
    }

    if (!result || result.error || !result.paired) {
      handledTokens.delete(token);
      writePairStatus(
        result?.error || "Automatic pairing failed. Paste the code into the popup to pair.",
        "error",
      );
      return;
    }

    if (!result.configured) {
      // Paired, but this build has no API base URL baked in (a hand-packed dev
      // zip). The token is stored, but nothing will sync until the URL is set.
      writePairStatus(
        "Paired ✓ — but this extension build is missing its API URL. Download a fresh zip above.",
        "error",
      );
      return;
    }

    writePairStatus("Paired this browser automatically ✓ You can close this dialog.", "ok");
  }

  // The slots swap in and out on tab switches and SPA navigations, so we watch
  // document.body for them. The catch is that mount() writes into that same
  // observed subtree (it inserts controls and sets their content), so a naive
  // observer re-fires on its own writes and loops until the tab freezes. We
  // defend two ways: affectsSlot ignores mutations that don't add or remove a
  // slot itself, and safeMount() disconnects the observer for the duration of
  // mount() so its writes can never feed back in.
  const REFRESH_SLOT_SELECTOR =
    '[data-booked-slot="social-posts-actions"],[data-booked-slot="needs-refresh"]';
  function affectsSlot(nodes, selector) {
    for (const node of nodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches?.(selector)) return true;
      if (node.querySelector?.(selector)) return true;
    }
    return false;
  }

  const OBSERVE_OPTS = { childList: true, subtree: true };
  const obs = new MutationObserver((records) => {
    let refresh = false;
    let pairing = false;
    for (const r of records) {
      if (
        affectsSlot(r.addedNodes, REFRESH_SLOT_SELECTOR) ||
        affectsSlot(r.removedNodes, REFRESH_SLOT_SELECTOR)
      ) {
        refresh = true;
      }
      // Only the token slot appearing matters for pairing; its removal (dialog
      // closed) is a no-op.
      if (affectsSlot(r.addedNodes, PAIR_TOKEN_SELECTOR)) pairing = true;
    }
    if (refresh) safeMount();
    if (pairing) void maybeAutoPair();
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
    // In case the pairing dialog is already open when the script initializes.
    void maybeAutoPair();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
  } else {
    void init();
  }
})();
