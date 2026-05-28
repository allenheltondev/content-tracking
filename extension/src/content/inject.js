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
    // Medium author + per-post stats endpoints.
    "/_/api/",
    "/_/graphql",
    // dev.to analytics dashboard + per-article shapes.
    "/api/analytics",
    "/api/articles",
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
    // Symbol stash keeps the captured URL off the enumerable surface that
    // fingerprinting code typically scans.
    const URL_KEY = Symbol("bookedUrl");
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = new Proxy(originalOpen, {
      apply(target, thisArg, args) {
        try {
          thisArg[URL_KEY] = args[1];
        } catch {
          /* ignore */
        }
        return Reflect.apply(target, thisArg, args);
      },
    });

    OriginalXHR.prototype.send = new Proxy(originalSend, {
      apply(target, thisArg, args) {
        try {
          thisArg.addEventListener("load", function () {
            try {
              const url = this.responseURL || this[URL_KEY];
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
        } catch {
          /* ignore */
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
  }
})();
