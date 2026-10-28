// ==M-Stream Bridge==
// @name        M-Stream Bridge
// @version     3.1.0
// @author      Zielzy
// @description Local bridge for non-DRM browser streams and Migaku Player.
// @homepage    https://github.com/Zielzy/M-Stream-Bridge
// ==/M-Stream Bridge==


!function() {
    "use strict";
    if (window.__MSTREAM_HOOKED__) return;
    window.__MSTREAM_HOOKED__ = !0;
    const FEATURES_XHR = !0, FEATURES_PARSE_MASTER = !0, FEATURES_STEALTH = !1, FEATURES_METRICS = !1, METRICS = {
        fetch: 0,
        xhr: 0,
        master: 0,
        variant: 0,
        redirect: 0,
        duplicate: 0,
        sent: 0,
        ignored: 0
    };
    function trackMetric(key) {
        FEATURES_METRICS && void 0 !== METRICS[key] && METRICS[key]++;
    }
    function notifyIsolatedWorld(url, method = "GET", type = "FETCH", extra = {}) {
        if ("string" == typeof url) try {
            window.postMessage({
                source: "__MSTREAM__",
                version: 1,
                type: type,
                payload: {
                    url: url,
                    method: method,
                    ...extra
                }
            }, "*"), trackMetric("sent");
        } catch (err) {}
    }
    function isTargetUrl(url) {
        if ("string" != typeof url) return !1;
        const u = url.toLowerCase();
        return !(u.includes(".js") || u.includes(".css") || u.includes(".png") || u.includes(".jpg") || u.includes(".woff") || u.includes(".json")) && (!(u.includes(".ts") || u.includes(".m4s") || u.match(/seg-\d/)) && u.includes(".m3u8"));
    }
    if (!0) {
        const originalFetch = window.fetch;
        async function hookedFetch(...args) {
            let url = "", method = "GET";
            try {
                args[0] instanceof Request ? (url = args[0].url, method = args[0].method || "GET") : ("string" == typeof args[0] || args[0] instanceof URL) && (url = args[0].toString(), 
                args[1] && args[1].method && (method = args[1].method));
            } catch (e) {}
            if (!isTargetUrl(url)) return trackMetric("ignored"), originalFetch.apply(this, args);
            trackMetric("fetch");
            let isMaster = !1;
            try {
                const response = await originalFetch.apply(this, args), finalUrl = response && response.url ? response.url : url;
                if (finalUrl !== url && trackMetric("redirect"), FEATURES_PARSE_MASTER && response && response.clone) try {
                    const clone = response.clone();
                    (await clone.text()).includes("#EXT-X-STREAM-INF") ? (isMaster = !0, trackMetric("master")) : trackMetric("variant");
                } catch (e) {}
                return notifyIsolatedWorld(finalUrl, method, "FETCH", {
                    isMaster: isMaster
                }), response;
            } catch (error) {
                throw error;
            }
        }
        window.fetch = hookedFetch, FEATURES_STEALTH && (window.fetch.toString = () => "function fetch() { [native code] }");
    }
    if (FEATURES_XHR) {
        const originalXhrOpen = XMLHttpRequest.prototype.open, xhrState = new WeakMap, attachedListeners = new WeakSet;
        function hookedXhrOpen(method, url, ...rest) {
            try {
                const urlStr = "string" == typeof url ? url : String(url);
                isTargetUrl(urlStr) ? (attachedListeners.has(this) || (attachedListeners.add(this), 
                this.addEventListener("load", function() {
                    const state = xhrState.get(this);
                    if (!state) return;
                    const finalUrl = this.responseURL || state.url;
                    finalUrl !== state.url && trackMetric("redirect");
                    let isMaster = !1;
                    FEATURES_PARSE_MASTER && this.responseText && (this.responseText.includes("#EXT-X-STREAM-INF") ? (isMaster = !0, 
                    trackMetric("master")) : trackMetric("variant")), notifyIsolatedWorld(finalUrl, state.method, "XHR", {
                        isMaster: isMaster
                    }), xhrState.delete(this);
                }, {
                    once: !0
                })), xhrState.set(this, {
                    url: urlStr,
                    method: method
                }), trackMetric("xhr")) : (xhrState.delete(this), trackMetric("ignored"));
            } catch (e) {}
            return originalXhrOpen.call(this, method, url, ...rest);
        }
        XMLHttpRequest.prototype.open = hookedXhrOpen, FEATURES_STEALTH && (XMLHttpRequest.prototype.open.toString = () => "function open() { [native code] }");
    }
    function notifyNavigation() {
        try {
            window.postMessage({
                source: "__MSTREAM__",
                version: 1,
                type: "NAV",
                payload: {
                    href: window.location.href
                }
            }, "*");
        } catch (e) {}
    }
    const originalPushState = history.pushState;
    history.pushState = function(...args) {
        const res = originalPushState.apply(this, args);
        return notifyNavigation(), res;
    };
    const originalReplaceState = history.replaceState;
    history.replaceState = function(...args) {
        const res = originalReplaceState.apply(this, args);
        return notifyNavigation(), res;
    }, window.addEventListener("popstate", notifyNavigation);
}();
