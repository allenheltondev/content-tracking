// MAIN-world interceptor. Runs in the page's own JS context (so it can see
// the site's fetch/XHR), wraps both, and forwards the response bodies of
// requests that look like analytics endpoints to the ISOLATED content
// script via window.postMessage. It must be self-contained — MAIN-world
// content scripts can't import modules — so the capture patterns are
// duplicated from src/adapters.js (CAPTURE_PATTERNS) by design.
//
// The wrappers are stealthed to defeat toString-based fingerprinting
// (LinkedIn's sensorCollect, others): a Proxy on Function.prototype
// .toString returns the original native source for our wrapped fetch/XHR
// methods, and their name/length match the originals. Without this,
// detection triggers an anti-extension probe that floods the page with
// chrome-extension://invalid/ requests.
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

  // ---- stealth --------------------------------------------------------------

  const nativeFnToString = Function.prototype.toString;
  const wrappedSources = new WeakMap();

  function stealth(wrapper, original) {
    try {
      wrappedSources.set(wrapper, nativeFnToString.call(original));
      Object.defineProperty(wrapper, "name", {
        value: original.name,
        configurable: true,
      });
      Object.defineProperty(wrapper, "length", {
        value: original.length,
        configurable: true,
      });
    } catch {
      /* ignore */
    }
  }

  // Intercept both fn.toString() and Function.prototype.toString.call(fn).
  // For functions we wrapped, return the original native source; for
  // everything else, defer to the real implementation.
  const toStringProxy = new Proxy(nativeFnToString, {
    apply(target, thisArg, args) {
      if (wrappedSources.has(thisArg)) return wrappedSources.get(thisArg);
      return Reflect.apply(target, thisArg, args);
    },
  });
  // Hide the proxy itself — calling .toString on it should still look native.
  wrappedSources.set(toStringProxy, nativeFnToString.call(nativeFnToString));
  try {
    Function.prototype.toString = toStringProxy;
  } catch {
    /* ignore */
  }

  // ---- fetch ----------------------------------------------------------------

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    const wrappedFetch = function fetch(...args) {
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
    stealth(wrappedFetch, originalFetch);
    window.fetch = wrappedFetch;
  }

  // ---- XHR ------------------------------------------------------------------

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;
    // Symbol keeps the captured URL off the enumerable surface that
    // fingerprinting code typically scans.
    const URL_KEY = Symbol("bookedUrl");

    const wrappedOpen = function open(method, url) {
      this[URL_KEY] = url;
      return originalOpen.apply(this, arguments);
    };
    const wrappedSend = function send() {
      this.addEventListener("load", function () {
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
      return originalSend.apply(this, arguments);
    };

    stealth(wrappedOpen, originalOpen);
    stealth(wrappedSend, originalSend);
    OriginalXHR.prototype.open = wrappedOpen;
    OriginalXHR.prototype.send = wrappedSend;
  }
})();
