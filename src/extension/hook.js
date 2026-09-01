// ==M-Stream Bridge==
// @name        M-Stream Bridge
// @version     __VERSION__
// @author      Zielzy
// @description Local bridge for non-DRM browser streams and Migaku Player.
// @homepage    https://github.com/Zielzy/M-Stream-Bridge
// ==/M-Stream Bridge==

/**
 * Manifest V3 MAIN World Parasite Hook (hook.js).
 * Intercepts window.fetch and XMLHttpRequest to capture .m3u8 playlist streams,
 * detects master playlists vs variants, and forwards metadata to the ISOLATED world.
 */
(function () {
  "use strict";

  // ==========================================================================
  // 1. Idempotency Guard & Feature Flags
  // ==========================================================================

  if (window.__MSTREAM_HOOKED__) return;
  window.__MSTREAM_HOOKED__ = true;

  const FEATURES = {
    FETCH: true,
    XHR: true,
    PARSE_MASTER: true,
    STEALTH: false, // Override toString only if necessary
    DEBUG: false,
    METRICS: false,
  };

  const METRICS = {
    fetch: 0,
    xhr: 0,
    master: 0,
    variant: 0,
    redirect: 0,
    duplicate: 0,
    sent: 0,
    ignored: 0,
  };

  // ==========================================================================
  // 2. Metrics & Debug Logging
  // ==========================================================================

  /**
   * Logs debug messages when debug feature flag is enabled.
   * @param {...*} args - Log arguments.
   */
  function logDebug(...args) {
    if (FEATURES.DEBUG) {
      console.log("[MSTREAM]", ...args);
    }
  }

  /**
   * Increments internal diagnostic performance metrics.
   * @param {string} key - Metric identifier key.
   */
  function trackMetric(key) {
    if (FEATURES.METRICS && METRICS[key] !== undefined) {
      METRICS[key]++;
    }
  }

  // ==========================================================================
  // 3. Secure Messaging & Hot-Path URL Filter
  // ==========================================================================

  /**
   * Dispatches window.postMessage payload to the extension's ISOLATED world script.
   * @param {string} url - Captured stream URL.
   * @param {string} method - HTTP request method (e.g. GET).
   * @param {string} type - Interception origin ("FETCH" | "XHR").
   * @param {Object} extra - Additional metadata flags like isMaster.
   */
  function notifyIsolatedWorld(url, method = "GET", type = "FETCH", extra = {}) {
    if (typeof url !== "string") return;

    try {
      window.postMessage({
        source: "__MSTREAM__",
        version: 1,
        type: type,
        payload: { url, method, ...extra },
      }, "*");
      trackMetric("sent");
    } catch (err) {
      logDebug("Failed to send message", err);
    }
  }

  /**
   * Fast-path URL validator to filter out static assets and non-stream traffic.
   * @param {string} url - Target URL to inspect.
   * @returns {boolean} True if URL points to a stream target (.m3u8).
   */
  function isTargetUrl(url) {
    if (typeof url !== "string") return false;
    const u = url.toLowerCase();

    // Ignore static web assets and segment chunks
    if (u.includes(".js") || u.includes(".css") || u.includes(".png") || u.includes(".jpg") || u.includes(".woff") || u.includes(".json")) return false;
    if (u.includes(".ts") || u.includes(".m4s") || u.match(/seg-\d/)) return false;

    return u.includes(".m3u8");
  }

  // ==========================================================================
  // 4. Hook: window.fetch
  // ==========================================================================

  if (FEATURES.FETCH) {
    const originalFetch = window.fetch;

    async function hookedFetch(...args) {
      let url = "";
      let method = "GET";

      try {
        if (args[0] instanceof Request) {
          url = args[0].url;
          method = args[0].method || "GET";
        } else if (typeof args[0] === "string" || args[0] instanceof URL) {
          url = args[0].toString();
          if (args[1] && args[1].method) method = args[1].method;
        }
      } catch (e) {
        // Fail-safe: if argument parsing fails, fallback to original fetch
      }

      // Hot-path optimization: skip non-stream requests immediately
      if (!isTargetUrl(url)) {
        trackMetric("ignored");
        return originalFetch.apply(this, args);
      }

      trackMetric("fetch");
      let isMaster = false;

      try {
        const response = await originalFetch.apply(this, args);
        const finalUrl = response && response.url ? response.url : url;

        if (finalUrl !== url) trackMetric("redirect");

        if (FEATURES.PARSE_MASTER && response && response.clone) {
          try {
            const clone = response.clone();
            const text = await clone.text();
            if (text.includes("#EXT-X-STREAM-INF")) {
              isMaster = true;
              trackMetric("master");
            } else {
              trackMetric("variant");
            }
          } catch (e) {
            logDebug("Fetch clone parse error", e);
          }
        }

        notifyIsolatedWorld(finalUrl, method, "FETCH", { isMaster });
        return response;
      } catch (error) {
        // Fail-safe: throw as normal so page error handling is undisturbed
        throw error;
      }
    }

    window.fetch = hookedFetch;

    // Stealth: Override toString to hide hook if enabled
    if (FEATURES.STEALTH) {
      window.fetch.toString = () => "function fetch() { [native code] }";
    }
  }

  // ==========================================================================
  // 5. Hook: XMLHttpRequest
  // ==========================================================================

  if (FEATURES.XHR) {
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const xhrState = new WeakMap();
    const attachedListeners = new WeakSet();

    function hookedXhrOpen(method, url, ...rest) {
      try {
        const urlStr = typeof url === "string" ? url : String(url);
        if (isTargetUrl(urlStr)) {
          if (!attachedListeners.has(this)) {
            attachedListeners.add(this);
            this.addEventListener("load", function () {
              const state = xhrState.get(this);
              if (!state) return;
              const finalUrl = this.responseURL || state.url;
              if (finalUrl !== state.url) trackMetric("redirect");

              let isMaster = false;
              if (FEATURES.PARSE_MASTER && this.responseText) {
                if (this.responseText.includes("#EXT-X-STREAM-INF")) {
                  isMaster = true;
                  trackMetric("master");
                } else {
                  trackMetric("variant");
                }
              }

              notifyIsolatedWorld(finalUrl, state.method, "XHR", { isMaster });
              xhrState.delete(this); // Prevent memory leaks
            }, { once: true });
          }
          xhrState.set(this, { url: urlStr, method });
          trackMetric("xhr");
        } else {
          xhrState.delete(this);
          trackMetric("ignored");
        }
      } catch (e) {
        logDebug("XHR open hook error", e);
      }
      return originalXhrOpen.call(this, method, url, ...rest);
    }

    XMLHttpRequest.prototype.open = hookedXhrOpen;

    if (FEATURES.STEALTH) {
      XMLHttpRequest.prototype.open.toString = () => "function open() { [native code] }";
    }
  }

  // ==========================================================================
  // 6. SPA Navigation Hook (pushState / replaceState / popstate)
  // ==========================================================================

  /**
   * Notifies extension when single-page application route transitions occur.
   */
  function notifyNavigation() {
    try {
      window.postMessage({
        source: "__MSTREAM__",
        version: 1,
        type: "NAV",
        payload: { href: window.location.href },
      }, "*");
    } catch (e) { }
  }

  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    const res = originalPushState.apply(this, args);
    notifyNavigation();
    return res;
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    const res = originalReplaceState.apply(this, args);
    notifyNavigation();
    return res;
  };

  window.addEventListener("popstate", notifyNavigation);
})();

