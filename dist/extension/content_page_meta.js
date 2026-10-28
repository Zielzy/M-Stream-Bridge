// ==M-Stream Bridge==
// @name        M-Stream Bridge
// @version     3.1.0
// @author      Zielzy
// @description Local bridge for non-DRM browser streams and Migaku Player.
// @homepage    https://github.com/Zielzy/M-Stream-Bridge
// ==/M-Stream Bridge==


!function() {
    "use strict";
    const {parseEpisodeFromText: parseEpisodeFromText, parseSeasonFromText: parseSeasonFromText} = globalThis.BridgeUtils, ALLOWED_JSON_LD_TYPES = new Set([ "Movie", "TVSeries", "VideoObject", "Episode", "CreativeWork", "AnimeSeries", "AnimeEpisode" ]);
    let lastSentKey = "", mutationSyncTimer = null, spaFollowupTimers = [];
    function scheduleMeta(force, delayMs = 220) {
        mutationSyncTimer && clearTimeout(mutationSyncTimer), mutationSyncTimer = setTimeout(() => {
            mutationSyncTimer = null, sendMeta(force);
        }, delayMs);
    }
    function cleanTitleCandidate(text) {
        return String(text || "").replace(/\s+/g, " ").trim();
    }
    const STANDALONE_NOISE_RE = /^(?:comments?|discussions?|(?:ep|episode)\.?\s*\d+)$/i;
    function buildMeta() {
        const pageUrl = location.href || "", title = document.title || "", {kind: pageKind, reason: pageReason} = function() {
            const pathname = location.pathname || "";
            if (/watch|anime|episode|title|series|movie|play/i.test(pathname)) return {
                kind: "entity",
                reason: "url_match"
            };
            const ogType = document.querySelector("meta[property='og:type']")?.getAttribute("content") || "";
            if (ogType.includes("video") || ogType.includes("movie") || ogType.includes("tv_show")) return {
                kind: "entity",
                reason: "og_video"
            };
            let hasEntityLd = !1;
            return document.querySelectorAll("script[type='application/ld+json']").forEach(el => {
                if (!hasEntityLd) try {
                    const data = JSON.parse(el.textContent || "null"), items = Array.isArray(data) ? data : [ data ];
                    for (const item of items) {
                        if (!item || "object" != typeof item) continue;
                        const type = "string" == typeof item["@type"] ? item["@type"] : Array.isArray(item["@type"]) ? item["@type"][0] : "";
                        ALLOWED_JSON_LD_TYPES.has(type) && (hasEntityLd = !0);
                    }
                } catch (_err) {}
            }), hasEntityLd ? {
                kind: "entity",
                reason: "jsonld_entity"
            } : {
                kind: "listing",
                reason: "default"
            };
        }();
        if ("listing" === pageKind) return {
            type: "bridge_ext_page_meta",
            page_url: pageUrl,
            title: title,
            title_candidates: [],
            episode: null,
            season: null,
            has_video: !1,
            video_count: document.querySelectorAll("video").length,
            is_top_frame: window === window.top,
            frame_url: location.href,
            perf_now: performance.now(),
            page_kind: pageKind,
            page_reason: pageReason
        };
        const titleCandidates = function() {
            const out = [], seen = new Set;
            function add(value, source = "unknown") {
                const cleaned = cleanTitleCandidate(value);
                if (!cleaned || cleaned.length < 2 || cleaned.length > 180) return;
                if (STANDALONE_NOISE_RE.test(cleaned)) return;
                const key = `${cleaned.toLowerCase()}::${source}`;
                seen.has(key) || (seen.add(key), out.push({
                    value: cleaned,
                    source: source
                }));
            }
            add(document.title || "", "title_tag"), [ {
                selector: "meta[property='og:title']",
                source: "og_title"
            }, {
                selector: "meta[name='twitter:title']",
                source: "twitter_title"
            }, {
                selector: "meta[name='title']",
                source: "title_tag"
            }, {
                selector: "meta[itemprop='name']",
                source: "heading"
            } ].forEach(({selector: selector, source: source}) => {
                document.querySelectorAll(selector).forEach(el => {
                    add(el.getAttribute("content"), source);
                });
            }), document.querySelectorAll("h1, h2, [itemprop='name']").forEach(el => {
                add(el.textContent, "heading");
            }), document.querySelectorAll("script[type='application/ld+json']").forEach(el => {
                try {
                    const data = JSON.parse(el.textContent || "null"), stack = Array.isArray(data) ? [ ...data ] : [ data ], collectionTypes = new Set([ "ItemList", "CollectionPage", "SearchResultsPage" ]);
                    for (;stack.length; ) {
                        const item = stack.shift();
                        if (!item || "object" != typeof item) continue;
                        const type = "string" == typeof item["@type"] ? item["@type"] : Array.isArray(item["@type"]) ? item["@type"][0] : "";
                        if (!type || !collectionTypes.has(type)) {
                            type && !ALLOWED_JSON_LD_TYPES.has(type) || ALLOWED_JSON_LD_TYPES.has(type) && (item.name && add(item.name, "json_ld"), 
                            item.alternateName && add(item.alternateName, "json_ld"), item.headline && add(item.headline, "json_ld"));
                            for (const value of Object.values(item)) Array.isArray(value) ? stack.push(...value) : value && "object" == typeof value && stack.push(value);
                        }
                    }
                } catch (_err) {}
            }), document.querySelectorAll("li, p, [class*='alias'], [class*='synonym'], [class*='alternative'], [class*='info'], [class*='detail']").forEach(el => {
                if (out.length >= 30) return;
                const match = cleanTitleCandidate(el.textContent || "").match(/^(?:alternative|synonyms?|japanese|english|romaji|native|other name)s?\s*[:：]\s*(.+)$/i);
                match && match[1].split(/[,/;|]/).forEach(v => add(v, "unknown"));
            });
            try {
                const segments = (location.pathname || "").split("/").filter(Boolean);
                for (const segment of segments) {
                    if (/^\d+$/.test(segment)) continue;
                    if (segment.length < 3) continue;
                    if (/^(watch|anime|episode|ep|series|tv|movie|play|video|embed|stream|season|sub|dub|page|category|genre|search|browse|home|index|api|v\d+)$/i.test(segment)) continue;
                    const titleFromSlug = segment.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
                    titleFromSlug && titleFromSlug.length >= 3 && add(titleFromSlug, "url_slug");
                }
            } catch (_err) {}
            return out.slice(0, 30);
        }(), episode = parseEpisodeFromText(pageUrl) || function() {
            const candidates = [];
            function addCandidate(ep, score, source) {
                !ep || ep < 1 || candidates.push({
                    ep: ep,
                    score: score,
                    source: source
                });
            }
            const strongSelectors = [ ".ssl-item.ep-item.active", ".ep-item.active", "[class*='episode'][class*='active']", "[class*='ep-'][class*='active']", "[aria-current='page']", "[data-episode].active", "[data-ep].active" ];
            for (const selector of strongSelectors) document.querySelectorAll(selector).forEach(el => {
                const text = String(el.textContent || ""), href = String(el.getAttribute("href") || ""), dataEpisode = String(el.getAttribute("data-episode") || el.getAttribute("data-ep") || "");
                addCandidate(parseEpisodeFromText(dataEpisode), 120, `${selector}:data`), addCandidate(parseEpisodeFromText(text), 110, `${selector}:text`), 
                addCandidate(parseEpisodeFromText(href), 105, `${selector}:href`);
            });
            return document.querySelectorAll("a[href]").forEach(a => {
                const href = String(a.getAttribute("href") || ""), text = String(a.textContent || ""), absHref = (() => {
                    try {
                        return new URL(href, location.href).href;
                    } catch (_err) {
                        return "";
                    }
                })();
                !absHref || absHref !== location.href && absHref.replace(/\/$/, "") !== location.href.replace(/\/$/, "") || (addCandidate(parseEpisodeFromText(text), 95, "anchor-current:text"), 
                addCandidate(parseEpisodeFromText(absHref), 90, "anchor-current:href")), /episode|ep|watch/i.test(href) && addCandidate(parseEpisodeFromText(href), 70, "anchor-href");
            }), candidates.length ? (candidates.sort((a, b) => b.score !== a.score ? b.score - a.score : b.ep - a.ep), 
            candidates[0].ep) : null;
        }() || parseEpisodeFromText(title) || null, season = parseSeasonFromText(pageUrl) || parseSeasonFromText(title) || null, videoCount = document.querySelectorAll("video").length;
        return {
            type: "bridge_ext_page_meta",
            page_url: pageUrl,
            title: title,
            title_candidates: titleCandidates,
            episode: episode,
            season: season,
            has_video: videoCount > 0,
            video_count: videoCount,
            is_top_frame: window === window.top,
            frame_url: location.href,
            perf_now: performance.now(),
            page_kind: pageKind,
            page_reason: pageReason
        };
    }
    function sendMeta(force) {
        const meta = buildMeta(), key = JSON.stringify([ meta.page_url, meta.episode, meta.season, meta.title, meta.title_candidates, meta.has_video, meta.video_count ]);
        if (force || key !== lastSentKey) {
            lastSentKey = key;
            try {
                chrome.runtime.sendMessage(meta, function() {
                    chrome.runtime.lastError;
                });
            } catch (_err) {}
        }
    }
    sendMeta(!0), setTimeout(() => sendMeta(!1), 1200), setInterval(() => {
        document.hidden || sendMeta(!1);
    }, 5e3);
    let lastHref = location.href;
    new MutationObserver(function() {
        if (location.href !== lastHref) return lastHref = location.href, spaFollowupTimers.forEach(timer => clearTimeout(timer)), 
        spaFollowupTimers = [], void (spaFollowupTimers = [ 50, 300, 800, 2e3 ].map(delay => setTimeout(() => sendMeta(!0), delay)));
        scheduleMeta(!1);
    }).observe(document.documentElement || document, {
        childList: !0,
        subtree: !0
    }), window.addEventListener("popstate", () => scheduleMeta(!0, 0), !0), window.addEventListener("hashchange", () => scheduleMeta(!0, 0), !0), 
    document.addEventListener("visibilitychange", function() {
        document.hidden || scheduleMeta(!1, 0);
    }), window.__MSTREAM_CAPTURED = [];
    let streamSendTimer = null;
    function sendBestStreamCandidate() {
        if (!window.__MSTREAM_CAPTURED.length) return;
        let best = window.__MSTREAM_CAPTURED[0], bestScore = -100;
        for (const candidate of window.__MSTREAM_CAPTURED) {
            let score = 10;
            candidate.isMaster && (score += 1e3);
            const u = candidate.url.toLowerCase();
            u.match(/4k|2160p?/) && (score += 100), u.includes("1080p") && (score += 90), u.includes("720p") && (score += 80), 
            u.includes("master") && (score += 40), u.includes("resolution") && (score += 30), 
            u.includes("index.m3u8") && (score += 20), u.includes(".m3u8") && (score += 20), 
            u.includes("/playlist/") && (score += 20), u.includes("/manifest/") && (score += 20), 
            (u.includes(".mp4") || u.includes(".webm")) && (score += 20), u.includes("/api/") && (score -= 100), 
            u.includes("transcript") && (score -= 100), (u.includes("json") || u.includes("graphql")) && (score -= 100), 
            u.match(/[/_-]?(init|segment|frag|part|chunk)\d*\.(mp4|m4s|m4a|m4v|webm)(\?|$)/) || (u.endsWith("init.mp4") || u.includes("init.mp4?") || u.includes("initialization") || u.includes("init-stream") || u.match(/\/(video|audio)_init/) || score > bestScore && (bestScore = score, 
            best = candidate));
        }
        if (!(bestScore < 0)) try {
            chrome.runtime.sendMessage({
                type: "bridge_ext_page_hook",
                url: best.url,
                method: best.method || "GET",
                isMaster: !!best.isMaster,
                pageUrl: location.href
            }, function() {
                chrome.runtime.lastError;
            }), showHookButton();
        } catch (e) {}
    }
    window.addEventListener("message", function(event) {
        if (event.source === window && event.data && "__MSTREAM__" === event.data.source && 1 === event.data.version) if ("NAV" !== event.data.type) {
            if (("FETCH" === event.data.type || "XHR" === event.data.type) && event.data.payload) {
                const url = event.data.payload.url;
                if (url.includes(".ts") || url.includes(".m4s")) return;
                if (!window.__MSTREAM_CAPTURED.find(c => c.url === url)) {
                    if (window.__MSTREAM_CAPTURED.push(event.data.payload), event.data.payload.isMaster) return streamSendTimer && clearTimeout(streamSendTimer), 
                    void sendBestStreamCandidate();
                    streamSendTimer && clearTimeout(streamSendTimer), streamSendTimer = setTimeout(() => {
                        sendBestStreamCandidate();
                    }, 3e3);
                }
            }
        } else window.__MSTREAM_CAPTURED = [];
    }), document.addEventListener("play", function(event) {
        event.target && "VIDEO" === event.target.tagName && (streamSendTimer && clearTimeout(streamSendTimer), 
        streamSendTimer = setTimeout(() => {
            sendBestStreamCandidate();
        }, 1500));
    }, !0);
    let mstreamBtnState = "IDLE", mstreamBtnRoot = null, resizeObs = null, intObs = null, rafPending = !1, lastClickAt = 0, trackingVideo = null;
    function findActiveVideo() {
        const videos = [ ...document.querySelectorAll("video") ], playing = videos.filter(v => {
            const r = v.getBoundingClientRect();
            return !v.paused && v.readyState >= 2 && r.width > 50 && r.height > 50 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
        });
        return (playing.length ? playing : videos.filter(v => {
            const r = v.getBoundingClientRect();
            return v.readyState >= 2 && r.width > 50 && r.height > 50 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
        })).sort((a, b) => {
            const rA = a.getBoundingClientRect(), rB = b.getBoundingClientRect();
            return rB.width * rB.height - rA.width * rA.height;
        })[0] || null;
    }
    function updatePosition() {
        if ("VISIBLE" !== mstreamBtnState || !mstreamBtnRoot) return;
        const video = findActiveVideo();
        if (!video) return;
        const rect = video.getBoundingClientRect();
        let topPos = rect.top - 28, leftPos = rect.left;
        topPos < 0 && (topPos = rect.top + 16, leftPos = rect.left + 16), mstreamBtnRoot.style.top = `${topPos}px`, 
        mstreamBtnRoot.style.left = `${leftPos}px`;
    }
    function setButtonState(state) {
        mstreamBtnRoot && (mstreamBtnState = state, "VISIBLE" === state ? (mstreamBtnRoot.style.opacity = "1", 
        mstreamBtnRoot.style.pointerEvents = "auto", mstreamBtnRoot.style.transform = "scale(1) translateY(0)", 
        updatePosition()) : "HIDDEN" === state && (mstreamBtnRoot.style.opacity = "0", mstreamBtnRoot.style.pointerEvents = "none", 
        mstreamBtnRoot.style.transform = "scale(0.95) translateY(-4px)"));
    }
    function attachObservers(video) {
        resizeObs && (resizeObs.disconnect(), resizeObs = null), intObs && (intObs.disconnect(), 
        intObs = null), trackingVideo = video, video && (resizeObs = new ResizeObserver(() => {
            "VISIBLE" === mstreamBtnState && updatePosition();
        }), resizeObs.observe(video), intObs = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                entry.isIntersecting ? "HIDDEN" === mstreamBtnState && setButtonState("VISIBLE") : "VISIBLE" === mstreamBtnState && setButtonState("HIDDEN");
            });
        }, {
            threshold: .1
        }), intObs.observe(video));
    }
    function showHookButton() {
        !function() {
            if (window.__mstreamFloatingButton) return !0;
            window.__mstreamFloatingButton = !0, mstreamBtnRoot = document.createElement("div"), 
            mstreamBtnRoot.id = "mstream-floating-root", Object.assign(mstreamBtnRoot.style, {
                position: "fixed",
                zIndex: "2147483647",
                pointerEvents: "none",
                top: "-999px",
                left: "-999px",
                opacity: "0",
                transform: "scale(0.9) translateY(-4px)",
                transition: "opacity 200ms ease-out, transform 200ms ease-out",
                display: "flex"
            });
            const btn = document.createElement("button");
            btn.id = "mstream-hook-btn", Object.assign(btn.style, {
                pointerEvents: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "2px 8px",
                background: "#f5f3fa",
                color: "#4B00B2",
                border: "1px solid rgba(75, 0, 178, 0.15)",
                borderRadius: "3px",
                boxShadow: "1px 1px 3px rgba(0,0,0,0.15)",
                cursor: "pointer",
                fontFamily: "'Segoe UI', 'Outfit', Arial, sans-serif",
                fontSize: "12px",
                fontWeight: "500",
                lineHeight: "1.2",
                transition: "all 0.1s ease",
                userSelect: "none",
                height: "24px",
                boxSizing: "border-box"
            });
            const iconUrl = chrome.runtime.getURL("icons/mstream.png");
            btn.innerHTML = `\n      <img src="${iconUrl}" alt="logo" style="width: 14px; height: 14px; border-radius: 1px;" />\n      <span>M-Stream Bridge</span>\n    `, 
            btn.addEventListener("mouseenter", () => {
                Object.assign(btn.style, {
                    background: "#6D28D9",
                    color: "#ffffff",
                    boxShadow: "2px 2px 6px rgba(0,0,0,0.3)"
                });
            }), btn.addEventListener("mouseleave", () => {
                Object.assign(btn.style, {
                    background: "#f5f3fa",
                    color: "#4B00B2",
                    boxShadow: "1px 1px 3px rgba(0,0,0,0.15)"
                });
            }), btn.addEventListener("click", () => {
                const now = Date.now();
                if (!(now - lastClickAt < 500)) {
                    lastClickAt = now;
                    try {
                        if (!chrome.runtime?.id) return;
                        chrome.runtime.sendMessage({
                            type: "bridge_open_popup"
                        }, () => {
                            chrome.runtime.lastError;
                        });
                    } catch (err) {}
                }
            }), mstreamBtnRoot.appendChild(btn), (document.documentElement || document.body).appendChild(mstreamBtnRoot), 
            window.addEventListener("scroll", () => {
                rafPending || (rafPending = !0, requestAnimationFrame(() => {
                    "VISIBLE" === mstreamBtnState && updatePosition(), rafPending = !1;
                }));
            }, {
                passive: !0,
                capture: !0
            }), new MutationObserver(() => {
                if ("IDLE" !== mstreamBtnState) {
                    const currentVideo = findActiveVideo();
                    currentVideo && currentVideo !== trackingVideo && (attachObservers(currentVideo), 
                    setButtonState("VISIBLE"));
                }
            }).observe(document.body || document.documentElement, {
                childList: !0,
                subtree: !0
            });
        }();
        const video = findActiveVideo();
        video && (attachObservers(video), setButtonState("VISIBLE"));
    }
    "undefined" != typeof chrome && chrome.runtime && chrome.runtime.onMessage && chrome.runtime.onMessage.addListener(message => {
        message && "bridge_force_meta_update" === message.type && sendMeta(!0);
    });
}();
