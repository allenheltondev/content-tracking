// ISOLATED-world content script for LinkedIn public-share post URLs
// (linkedin.com/posts/<slug>). LinkedIn uses three URN types for posts
// — urn:li:activity, urn:li:ugcPost, urn:li:share — and they have
// distinct numeric ids. Slug URLs embed a share or ugcPost id, but the
// analytics page only accepts activity ids, with no derivable mapping
// between the two. Scrape the activity URN off the rendered page and
// report it back to the background, which caches it and triggers an
// auto-scrape of the analytics URL.

(function () {
  function extractActivityId() {
    const html = document.documentElement.outerHTML;
    const counts = new Map();
    for (const m of html.matchAll(/urn:li:activity:(\d+)/g)) {
      const id = m[1];
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    if (!counts.size) return null;
    // Take the most frequently referenced activity URN — this post's
    // own URN appears repeatedly (share buttons, reaction links,
    // tracking pixels), while URNs of linked-to posts tend to appear
    // once or twice.
    let bestId = null;
    let bestCount = 0;
    for (const [id, c] of counts) {
      if (c > bestCount) { bestId = id; bestCount = c; }
    }
    return bestId;
  }

  function report(activityId) {
    chrome.runtime
      .sendMessage({
        type: "booked:resolvedPost",
        platform: "linkedin",
        url: location.href,
        activityId,
      })
      .catch(() => {});
  }

  let attempts = 0;
  let reported = null;

  // Poll briefly: hydration sometimes adds extra activity-URN references
  // (e.g. lazy-loaded share buttons), so the "most frequent" id can
  // stabilize a beat after document_idle.
  function poll() {
    const id = extractActivityId();
    if (id && id !== reported) {
      reported = id;
      report(id);
    }
    if (++attempts < 10) setTimeout(poll, 500); // ~5s
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", poll, { once: true });
  } else {
    poll();
  }
})();
