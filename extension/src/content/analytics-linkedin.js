// ISOLATED-world content script for LinkedIn's post-summary analytics
// pages. LinkedIn migrated those pages to SDUI-rendered React Server
// Components — the engagement counts are rendered into the DOM rather
// than carried in a JSON API response we can intercept. This scrapes
// the rendered numbers and forwards them to the background through a
// dedicated `booked:scraped` message that bypasses the JSON adapter
// pipeline (we've already extracted; nothing left to parse).

(function () {
  const POST_SUMMARY_RE = /\/analytics\/post-summary\/urn:li:activity:(\d+)/;

  function parsePostId() {
    const m = POST_SUMMARY_RE.exec(location.pathname);
    return m ? m[1] : null;
  }

  // LinkedIn occasionally renders large counts as "1.2K" / "3.4M" — handle
  // both that and plain comma-separated digits.
  function parseNumber(text) {
    if (!text) return null;
    const cleaned = String(text).trim().replace(/,/g, "");
    const m = /^([\d.]+)([KMB])?$/i.exec(cleaned);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const mult = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[(m[2] || "").toUpperCase()] || 1;
    return Math.round(n * mult);
  }

  function findNumberInTree(root, exclude) {
    for (const p of root.querySelectorAll("p")) {
      if (p === exclude) continue;
      const t = p.textContent.trim();
      if (/^[\d,]+[KMB]?$/i.test(t)) {
        const n = parseNumber(t);
        if (n != null) return n;
      }
    }
    return null;
  }

  // Find a <p> whose exact text matches the label, then walk up the
  // ancestor chain looking for a sibling <p> containing a number. The
  // label match is language-dependent — works for the default English
  // UI, brittle on localized accounts; acceptable starting point.
  function findNumberByLabel(label) {
    const wanted = label.toLowerCase();
    for (const p of document.querySelectorAll("p")) {
      if (p.textContent.trim().toLowerCase() !== wanted) continue;
      let node = p.parentElement;
      for (let depth = 0; depth < 5 && node; depth++) {
        const n = findNumberInTree(node, p);
        if (n != null) return n;
        node = node.parentElement;
      }
    }
    return null;
  }

  // Anchor on the per-action analytics URL's resultType param, which
  // isn't localized. Used for Reactions/Comments/Reposts.
  function findNumberByResultType(type) {
    const a = document.querySelector(`a[href*="resultType=${type}"]`);
    return a ? findNumberInTree(a, null) : null;
  }

  function findNumberByComponentKey(key) {
    const el = document.querySelector(`[componentkey="${key}"]`);
    return el ? findNumberInTree(el, null) : null;
  }

  function extract() {
    const metrics = {};
    const impressions = findNumberByLabel("Impressions");
    if (impressions != null) metrics.impressions = impressions;
    // membersReachedFeature componentkey is stable across class rotations;
    // fall back to label text if LinkedIn ever renames it.
    const reach =
      findNumberByComponentKey("membersReachedFeature") ??
      findNumberByLabel("Members reached");
    if (reach != null) metrics.reach = reach;
    const likes = findNumberByResultType("REACTIONS");
    if (likes != null) metrics.likes = likes;
    const comments = findNumberByResultType("COMMENTS");
    if (comments != null) metrics.comments = comments;
    const reposts = findNumberByResultType("RESHARES");
    if (reposts != null) metrics.reposts = reposts;
    const saves = findNumberByLabel("Saves");
    if (saves != null) metrics.saves = saves;
    const sends = findNumberByLabel("Sends on LinkedIn");
    if (sends != null) metrics.sends = sends;
    return metrics;
  }

  const postId = parsePostId();
  if (!postId) return;

  let lastSnapshot = null;

  function send(metrics) {
    const snapshot = JSON.stringify(metrics);
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    chrome.runtime
      .sendMessage({
        type: "booked:scraped",
        platform: "linkedin",
        nativeId: postId,
        metrics,
        pageUrl: location.href,
      })
      .catch(() => {});
  }

  function tryExtract() {
    const metrics = extract();
    if (!Object.keys(metrics).length) return false;
    send(metrics);
    return true;
  }

  // SDUI hydration can take a few seconds after document_idle. Poll
  // briefly, then leave a MutationObserver in place to catch late or
  // updated numbers (the snapshot dedupe keeps us from re-sending
  // identical payloads on every mutation tick).
  let attempts = 0;
  function poll() {
    const got = tryExtract();
    if (got || ++attempts >= 30) {
      const obs = new MutationObserver(() => {
        try { tryExtract(); } catch { /* ignore */ }
      });
      obs.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      return;
    }
    setTimeout(poll, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", poll, { once: true });
  } else {
    poll();
  }
})();
