// ISOLATED-world content script. Bridges the MAIN-world interceptor
// (inject.js) to the background service worker: it receives the captured
// response bodies via window.postMessage and relays them — tagged with the
// platform and current page URL — to the background, which does the actual
// metric extraction and sync.
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

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__booked !== true || data.kind !== "response") return;

    chrome.runtime
      .sendMessage({
        type: "booked:captured",
        platform,
        url: data.url,
        body: data.body,
        pageUrl: location.href,
      })
      .catch(() => {
        // Background may be asleep or the context invalidated on reload;
        // the next captured response will retry.
      });
  });
})();
