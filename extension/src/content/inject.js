// MAIN-world interceptor. Runs in the page's own JS context (so it can see
// the site's fetch/XHR), wraps both, and forwards the response bodies of
// requests that look like analytics endpoints to the ISOLATED content
// script via window.postMessage. It must be self-contained — MAIN-world
// content scripts can't import modules — so the capture patterns are
// duplicated from src/adapters.js (CAPTURE_PATTERNS) by design.
//
// Stealth: wrappers are Proxy(originalFn, { apply }), which transparently
// mirror the target's name, length, prototype shape, and toString output.
// No global Function.prototype.toString patch is needed (and avoiding it
// removes one of the surfaces LinkedIn's sensorCollect fingerprints on).
(function () {
  const CAPTURE = [
    "/graphql",
    "/i/api/graphql",
    "api.x.com",
    "/voyager/api",
    "/api/v1/media",
    "/graphql/query",
    "/api/graphql",
    // Bluesky AppView feed reads — hydrated postViews carry the counts.
    "/xrpc/app.bsky.feed.",
    // Single-post permalink views load through the unspecced thread
    // endpoint (getPostThreadV2 / getPostThreadOtherV2), which carries the
    // anchor post's counts but sits outside the app.bsky.feed.* namespace.
    "/xrpc/app.bsky.unspecced.getPostThread",
    // Medium author + per-post stats endpoints.
    "/_/api/",
    "/_/graphql",
    // dev.to analytics dashboard + per-article shapes.
    "/api/analytics",
    "/api/articles",
    // Hashnode dashboard post stats.
    "/ajax/user/post-stats",
    "gql.hashnode.com",
  ];

  function shouldCapture(url) {
    return typeof url === "string" && CAPTURE.some((p) => url.includes(p));
  }

  function forward(url, body) {
    if (!body || body.length > 5_000_000) return; // skip absurd payloads
    try {
      window.postMessage({ __booked: true, kind: "response", url, body }, "*");
    } catch {
      /* ignore */
    }
  }

  // ---- fetch ----------------------------------------------------------------

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = new Proxy(originalFetch, {
      apply(target, thisArg, args) {
        const promise = Reflect.apply(target, thisArg, args);
        promise
          .then((response) => {
            const url =
              response?.url || (typeof args[0] === "string" ? args[0] : args[0]?.url);
            if (shouldCapture(url)) {
              response
                .clone()
                .text()
                .then((text) => forward(url, text))
                .catch(() => {});
            }
          })
          .catch(() => {});
        return promise;
      },
    });
  }

  // ---- XHR ------------------------------------------------------------------

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    // Only `open` is wrapped, and the load listener is attached there for
    // matching URLs only. `send` is left untouched on purpose: when the page's
    // CSP blocks an unrelated XHR (e.g. Google Analytics on medium.com), Chrome
    // logs the violation with the stack of the `send` call. A wrapped `send`
    // put this file in that stack, so the block was attributed to the
    // extension on chrome://extensions Errors even though the page caused it.
    const originalOpen = OriginalXHR.prototype.open;

    OriginalXHR.prototype.open = new Proxy(originalOpen, {
      apply(target, thisArg, args) {
        try {
          if (shouldCapture(String(args[1]))) {
            thisArg.addEventListener("load", function () {
              try {
                const url = this.responseURL || String(args[1]);
                if (!shouldCapture(url)) return;
                const type = this.responseType;
                if (type === "" || type === "text") {
                  forward(url, this.responseText);
                } else if (type === "json" && this.response) {
                  forward(url, JSON.stringify(this.response));
                }
              } catch {
                /* ignore */
              }
            });
          }
        } catch {
          /* ignore */
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
  }
})();
