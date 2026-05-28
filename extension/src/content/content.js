// ISOLATED-world content script. Bridges the MAIN-world interceptor
// (inject.js) to the background service worker: it receives the captured
// response bodies via a CustomEvent on document and relays them — tagged
// with the platform and current page URL — to the background, which does
// the actual metric extraction and sync.
(function () {
  function detectPlatform() {
    const host = location.hostname.replace(/^www\./, "");
    if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) {
      return "twitter";
    }
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
    return null;
  }

  const platform = detectPlatform();
  if (!platform) return;

  const CAPTURE_EVENT = "__booked_capture_v1";

  document.addEventListener(CAPTURE_EVENT, (event) => {
    let payload;
    try {
      payload = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!payload || typeof payload.url !== "string") return;

    chrome.runtime
      .sendMessage({
        type: "booked:captured",
        platform,
        url: payload.url,
        body: payload.body,
        pageUrl: location.href,
      })
      .catch(() => {
        // Background may be asleep or the context invalidated on reload;
        // the next captured response will retry.
      });
  });
})();
