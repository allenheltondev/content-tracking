// MAIN-world interceptor. Runs in the page's own JS context (so it can see
// the site's fetch/XHR), wraps both, and forwards the response bodies of
// requests that look like analytics endpoints to the ISOLATED content
// script via window.postMessage. It must be self-contained — MAIN-world
// content scripts can't import modules — so the capture patterns are
// duplicated from src/adapters.js (CAPTURE_PATTERNS) by design.
(function () {
  const CAPTURE = [
    "/graphql",
    "/i/api/graphql",
    "api.x.com",
    "/voyager/api",
    "/api/v1/media",
    "/graphql/query",
    "/api/graphql",
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

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      const promise = originalFetch.apply(this, args);
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
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    const open = OriginalXHR.prototype.open;
    const send = OriginalXHR.prototype.send;
    OriginalXHR.prototype.open = function (method, url) {
      this.__bookedUrl = url;
      return open.apply(this, arguments);
    };
    OriginalXHR.prototype.send = function () {
      this.addEventListener("load", function () {
        try {
          const url = this.responseURL || this.__bookedUrl;
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
      return send.apply(this, arguments);
    };
  }
})();
