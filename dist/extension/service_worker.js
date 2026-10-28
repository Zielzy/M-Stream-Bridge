// ==M-Stream Bridge==
// @name        M-Stream Bridge
// @version     3.1.0
// @author      Zielzy
// @description Local bridge for non-DRM browser streams and Migaku Player.
// @homepage    https://github.com/Zielzy/M-Stream-Bridge
// ==/M-Stream Bridge==


self.addEventListener("install", () => {
    self.skipWaiting();
});

import "./shared/utils.js";

const {parseEpisodeFromText: parseEpisodeFromText, parseSeasonFromText: parseSeasonFromText, extractEpisodeFromUrl: extractEpisodeFromUrl} = globalThis.BridgeUtils, BRIDGE_ORIGIN = "http://127.0.0.1:7000", CAPTURE_ENDPOINT = `${BRIDGE_ORIGIN}/capture-request`, CAPTURE_EVENT_ENDPOINT = `${BRIDGE_ORIGIN}/capture-event`, SET_STREAM_ENDPOINT = `${BRIDGE_ORIGIN}/set-stream`, LOG_PREFIX = "[BRIDGE-EXT]", LOG_LEVEL = "info", DEFAULT_MIGAKU_EXTENSION_ID = "dmeppfcidcpcocleneopiblmpnbokhep", MIGAKU_PLAYER_PATH = "/pages/player/index.html", MAX_HEADER_VALUE_LEN = 4096, MAX_CACHE_SIZE = 2e3, MAX_COOLDOWN_KEYS = 1e3, STREAM_SET_COOLDOWN_HLS_MS = 3e4, STREAM_SET_COOLDOWN_DIRECT_MS = 15e3, STREAM_SET_COOLDOWN_TAB_MS = 3e3, AUTO_STREAM_TYPES = new Set([ "hls", "direct" ]), ALLOWED_REQUEST_TYPES = new Set([ "media", "xmlhttprequest", "fetch", "sub_frame", "object" ]), TAB_RECENT_TTL_MS = 3e5, TAB_SWITCH_SET_COOLDOWN_MS = 3e3, TAB_META_TTL_MS = 6e5, MAX_CANDIDATES_PER_TAB = 8, MAX_TAB_STATE_ENTRIES = 200, RESPONSE_STREAM_CONTENT_TYPES = new Set([ "application/vnd.apple.mpegurl", "application/x-mpegurl", "application/octet-stream", "video/mp4", "video/webm", "video/MP2T", "video/iso.segment", "video/x-m4v" ]), requestCache = new Map, lastSetByKey = new Map, tabRecentPrimary = new Map, tabPageMeta = new Map;

let activeTabId = -1;

function shouldLog(level) {
    return "debug" !== level;
}

function logDebug(...args) {
    shouldLog("debug");
}

function logInfo(...args) {
    shouldLog("info");
}

function nowIso() {
    return (new Date).toISOString();
}

function isStaticNoiseUrl(url) {
    return /\.(js|css|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|map)(\?|$)/i.test(url);
}

function isBridgeLocalUrl(url) {
    const value = String(url || "").trim();
    if (!value) return !1;
    try {
        const parsed = new URL(value), host = parsed.hostname.toLowerCase();
        return "7000" === (parsed.port || ("https:" === parsed.protocol ? "443" : "80")) && ("localhost" === host || "127.0.0.1" === host || "::1" === host);
    } catch (_err) {
        return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):7000(?:\/|$)/i.test(value);
    }
}

function isSubtitleLikeUrl(url) {
    const value = String(url || "").toLowerCase();
    if (!value) return !1;
    try {
        const parsed = new URL(value), path = parsed.pathname.toLowerCase(), query = parsed.search.toLowerCase();
        return /\/(?:subtitles?|captions?|cc)(?:\/|$)/i.test(path) || /(?:^|[_\-.])sub(?:[_\-.]|$)/i.test(path) || /(?:^|[_\-.])(?:eng|jpn|japanese|ja)(?:[_\-.]sub|[_\-.]cc)/i.test(path) || /\.(?:srt|vtt|ass|ssa)(?:$|[?#])/i.test(value) || /(?:^|[?&])(?:subtitle|caption|sub|cc)=/i.test(query);
    } catch (_err) {
        return /\/(?:subtitles?|captions?|cc)(?:\/|$)/i.test(value) || /\.(?:srt|vtt|ass|ssa)(?:$|[?#])/i.test(value);
    }
}

function hasMediaSignature(url) {
    return !(!url || "string" != typeof url) && (!isBridgeLocalUrl(url) && (!isSubtitleLikeUrl(url) && (!!/\.(m3u8|m3u|ts|m4s|mp4|webm|mkv|mov|key)(\?|&|$)/i.test(url) || (!!/(videoplayback|master\.m3u8|index-.*\.m3u8|\/hls\d*\/|\/dash\/|\/stream\/|\/segment\/|\/dl\/|\/playlist\/|\/manifest\/|\/rendition\/)/i.test(url) || !!/\/(?:m3|m3u8|play|hls|src|stream|video|token|embed|v|e)\/[A-Za-z0-9+/=_%\-]{40,}/i.test(url)))));
}

function isInterestingUrl(url) {
    return !(!url || "string" != typeof url) && (!isBridgeLocalUrl(url) && (!isSubtitleLikeUrl(url) && (!!hasMediaSignature(url) && (!(isStaticNoiseUrl(url) && !/\.(m3u8|mpd)(\?|$)/i.test(url)) && !/\.(html?|php|aspx?|jsp)(\?|$)/i.test(url)))));
}

function isAllowedRequestType(requestType) {
    return ALLOWED_REQUEST_TYPES.has(String(requestType || "").toLowerCase());
}

function inferStreamType(url) {
    const lowered = String(url || "").toLowerCase();
    return lowered && (!(lowered.includes("/api/") || lowered.includes("/episodes?") || lowered.endsWith(".json") || lowered.includes(".json?")) || lowered.includes(".m3u8") || lowered.includes(".mp4")) ? lowered.includes(".m3u8") || /(\/manifest\/|\/playlist\/|master\.m3u8|index-.*\.m3u8|\/hls\d*\/|\/rendition\/)/i.test(lowered) ? "hls" : lowered.includes("videoplayback") || /\.(mp4|webm|mkv|mov|m4v)(\?|&|$)/i.test(lowered) || /(\/dl\/|\/download\/)/i.test(lowered) ? "direct" : "other" : "other";
}

function isLikelyAudioHlsUrl(url) {
    const lowered = String(url || "").toLowerCase();
    return !!lowered && (!!/\/lang\/[a-z]{2,3}(?:\/|$)/i.test(lowered) || (!!/\/audio(?:\/|[-_]|$)|\/aud(?:\/|[-_]|$)/i.test(lowered) || !(!/(?:^|[\/._-])(tha|eng|jpn|jap|ind|spa|fre|fra|ger|deu|por|rus|ita|kor|chi|zho)(?:[\/._-]|$)/i.test(lowered) || /(master\.m3u8|index-v\d|\/video\/|1080|720|480|360)/i.test(lowered))));
}

function isSegmentLikeUrl(url) {
    const lowered = String(url || "").toLowerCase();
    return !!lowered && (!!/\.(ts|m4s)(\?|$)/i.test(lowered) || !!/(?:^|[\/._-])(seg(?:ment)?|chunk|frag(?:ment)?)(?:[\/._-]|\d|$)/i.test(lowered));
}

function isPrimaryHlsUrl(url) {
    const lowered = String(url || "").toLowerCase(), hasM3u8 = lowered.includes(".m3u8"), hasHlsPath = /(\/hls\d*\/|\/playlist\/|\/manifest\/|\/rendition\/|\/dash\/)/i.test(lowered);
    return !(!hasM3u8 && !hasHlsPath) && (!isLikelyAudioHlsUrl(lowered) && (!/(seg-\d+|chunk|fragment)/i.test(lowered) && (!hasM3u8 || !/(encryption\.key|\/key\.|\.ts(\?|&|$)|\.m4s(\?|&|$)|\.jpg(\?|&|$)|\.html(\?|&|$))/i.test(lowered))));
}

function isHlsMasterUrl(url) {
    const lowered = String(url || "").toLowerCase();
    return !!lowered.includes(".m3u8") && /(^|\/)(master|index|playlist|manifest)[^/]*\.m3u8(?:[?#]|$)/i.test(lowered);
}

function isLikelyHlsVariantUrl(url) {
    const lowered = String(url || "").toLowerCase();
    return !!lowered.includes(".m3u8") && (!isHlsMasterUrl(lowered) && (!!/(?:^|[\/._-])(?:1080|720|480|360|2160|4k|[0-9]{5,})(?:p)?[\/._-]?[^/]*\.m3u8(?:[?#]|$)/i.test(lowered) || !!/(?:^|[\/._-])(?:video|rendition|variant)[\/._-]?[^/]*\.m3u8(?:[?#]|$)/i.test(lowered)));
}

function hlsSessionKey(url) {
    try {
        const parsed = new URL(url), parts = parsed.pathname.split("/").filter(Boolean);
        return parts.length <= 1 ? parsed.origin : `${parsed.origin}/${parts.slice(0, -1).join("/")}`;
    } catch (_err) {
        return "";
    }
}

function shouldPostCapture(url, streamType) {
    const lowered = String(url || "").toLowerCase();
    return !!lowered && (!isSegmentLikeUrl(lowered) && ((!/\.(ts|m4s|mp4|webm|mp3|aac)(\?|$)/i.test(lowered) || "direct" === streamType) && ((!/(?:^|[?&])range=\d+-\d+/i.test(lowered) || "direct" === streamType) && ("hls" === streamType ? isPrimaryHlsUrl(lowered) : "direct" === streamType ? !isLikelyAudioDirectUrl(lowered) && !isLikelyBackgroundVideoUrl(lowered) : !("other" !== streamType || !isPrimaryHlsUrl(lowered))))));
}

function isLikelyAudioDirectUrl(url) {
    const lowered = String(url || "").toLowerCase();
    if (!lowered) return !1;
    const hasAudioCue = /(^|[\/_-])audio([\/_-]|\d|$)|\/audio\//i.test(lowered), hasVideoCue = /(^|[\/_-])video([\/_-]|\d|$)|\/video\//i.test(lowered) || /(1080p|720p|480p|360p|itag=)/i.test(lowered);
    return hasAudioCue && !hasVideoCue;
}

function isLikelyBackgroundVideoUrl(url) {
    const lowered = String(url || "").toLowerCase();
    return !!lowered && /(background|bg-video|icon-|thumb|hover-video)/i.test(lowered);
}

function isStreamContentType(contentTypeValue) {
    if (!contentTypeValue) return !1;
    const ct = contentTypeValue.toLowerCase().split(";")[0].trim();
    return !!RESPONSE_STREAM_CONTENT_TYPES.has(ct) || !!(ct.includes("mpegurl") || ct.includes("mp2t") || ct.includes("m4v"));
}

function normalizeUrlKey(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return `${parsed.origin}${parsed.pathname}`;
    } catch (_err) {
        return "";
    }
}

function sanitizeHeaders(headers) {
    const out = {};
    if (!Array.isArray(headers)) return out;
    for (const item of headers) {
        const name = String(item?.name || "").trim().toLowerCase();
        if (!name) continue;
        if ([ "host", "content-length", "connection", "transfer-encoding" ].includes(name)) continue;
        const value = String(item?.value || "").trim();
        value && (out[name] = value.slice(0, 4096));
    }
    return out;
}

function trimCache() {
    if (requestCache.size <= 2e3) return;
    const keys = requestCache.keys();
    for (;requestCache.size > 2e3; ) {
        const first = keys.next();
        if (first.done) break;
        requestCache.delete(first.value);
    }
}

function trimCooldownCache() {
    if (lastSetByKey.size <= 1e3) return;
    const keys = lastSetByKey.keys();
    for (;lastSetByKey.size > 1e3; ) {
        const first = keys.next();
        if (first.done) break;
        lastSetByKey.delete(first.value);
    }
}

function trimTabRecent() {
    const now = Date.now();
    for (const [tabId, item] of tabRecentPrimary.entries()) item && item.candidates && 0 !== item.candidates.length ? (item.candidates = item.candidates.filter(c => c.lastSeenAt && now - c.lastSeenAt <= 3e5), 
    item.candidates.length ? item.bestIdx = bestCandidateIndex(item.candidates) : tabRecentPrimary.delete(tabId)) : tabRecentPrimary.delete(tabId);
    for (;tabRecentPrimary.size > 200; ) {
        let oldestTabId = null, oldestSeenAt = 1 / 0;
        for (const [tabId, item] of tabRecentPrimary.entries()) {
            const newestCandidateAt = Math.max(...item.candidates.map(candidate => Number(candidate.lastSeenAt || 0)));
            newestCandidateAt < oldestSeenAt && (oldestSeenAt = newestCandidateAt, oldestTabId = tabId);
        }
        if (null === oldestTabId) break;
        tabRecentPrimary.delete(oldestTabId);
    }
}

function trimTabMeta() {
    const now = Date.now();
    for (const [tabId, meta] of tabPageMeta.entries()) (!meta || !meta.at || now - meta.at > 6e5) && tabPageMeta.delete(tabId);
    for (;tabPageMeta.size > 200; ) {
        let oldestTabId = null, oldestAt = 1 / 0;
        for (const [tabId, meta] of tabPageMeta.entries()) {
            const at = Number(meta?.at || 0);
            at < oldestAt && (oldestAt = at, oldestTabId = tabId);
        }
        if (null === oldestTabId) break;
        tabPageMeta.delete(oldestTabId);
    }
}

function bestCandidateIndex(candidates) {
    let bestScore = -1 / 0, bestIdx = 0;
    for (let i = 0; i < candidates.length; i++) candidates[i].score > bestScore && (bestScore = candidates[i].score, 
    bestIdx = i);
    return bestIdx;
}

async function postCapture(payload) {
    try {
        const resp = await fetch(CAPTURE_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            keepalive: !0
        });
        resp.ok || logDebug("capture rejected", resp.status, payload.url);
    } catch (err) {
        logDebug("capture unavailable", String(err));
    }
}

async function postCaptureEvent(payload) {
    try {
        const resp = await fetch(CAPTURE_EVENT_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            keepalive: !0
        });
        resp.ok || logDebug("capture event rejected", resp.status);
    } catch (err) {
        logDebug("capture event unavailable", String(err));
    }
}

async function postSetStream(payload) {
    try {
        const resp = await fetch(SET_STREAM_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            keepalive: !0
        });
        if (!resp.ok) return void logDebug("set-stream rejected", resp.status, payload.stream_url);
        logInfo("set-stream ok", payload.stream_type, payload.stream_url, `s=${payload.season || "-"} ep=${payload.episode || "-"}`);
    } catch (err) {
        logDebug("set-stream unavailable", String(err));
    }
}

function deriveReferer(details, tabInfo) {
    const candidates = [ details?.initiator || "", details?.documentUrl || "", tabInfo?.url || "" ];
    for (const raw of candidates) {
        const text = String(raw || "").trim();
        if (text.startsWith("http://") || text.startsWith("https://")) return text;
    }
    return "";
}

function deriveOrigin(urlText) {
    try {
        const parsed = new URL(urlText);
        return `${parsed.protocol}//${parsed.host}`;
    } catch (_err) {
        return "";
    }
}

function shouldSetStream(url, streamType, tabId = -1) {
    if (!AUTO_STREAM_TYPES.has(streamType)) return !1;
    if (isBridgeLocalUrl(url)) return !1;
    if (isSubtitleLikeUrl(url)) return !1;
    if ("direct" === streamType && isLikelyAudioDirectUrl(url)) return !1;
    if ("hls" === streamType && !isPrimaryHlsUrl(url)) return !1;
    const now = Date.now(), key = normalizeUrlKey(url) || url, prev = lastSetByKey.get(key) || 0, cooldownMs = "hls" === streamType ? 3e4 : 15e3;
    if (now - prev < cooldownMs) {
        const elapsed = now - prev;
        return logDebug(`cooldown reject | layer=URL | source=webRequest | key=${key} | elapsed=${elapsed}ms | remaining=${cooldownMs - elapsed}ms`), 
        !1;
    }
    if (tabId >= 0) try {
        const tabKey = `tab:${tabId}:host:${new URL(url).hostname}:type:${streamType}`, tabPrev = lastSetByKey.get(tabKey) || 0;
        if (now - tabPrev < 3e3) {
            const elapsed = now - tabPrev;
            return logDebug(`cooldown reject | layer=TAB | source=webRequest | key=${tabKey} | elapsed=${elapsed}ms | remaining=${3e3 - elapsed}ms`), 
            !1;
        }
        lastSetByKey.set(tabKey, now);
    } catch (_err) {}
    return lastSetByKey.set(key, now), trimCooldownCache(), !0;
}

function shouldSetFromTabSwitch(url) {
    const key = `tab-switch:${normalizeUrlKey(url) || url}`, now = Date.now();
    return !(now - (lastSetByKey.get(key) || 0) < 3e3) && (lastSetByKey.set(key, now), 
    trimCooldownCache(), !0);
}

function findRecentHlsMasterForTab(tabId, url) {
    if ("number" != typeof tabId || tabId < 0) return null;
    const entry = tabRecentPrimary.get(tabId);
    if (!entry || !Array.isArray(entry.candidates)) return null;
    const targetSession = hlsSessionKey(url);
    let best = null;
    for (const candidate of entry.candidates) {
        const candidateUrl = String(candidate?.payload?.url || "");
        candidateUrl && isHlsMasterUrl(candidateUrl) && (targetSession && hlsSessionKey(candidateUrl) !== targetSession || (!best || Number(candidate.score || 0) > Number(best.score || 0)) && (best = candidate));
    }
    return best;
}

function shouldDeferHlsVariantToMaster(tabId, url) {
    return isLikelyHlsVariantUrl(url) && Boolean(findRecentHlsMasterForTab(tabId, url));
}

function buildPayload(details) {
    const url = details?.url || "", headers = sanitizeHeaders(details?.requestHeaders || []), key = normalizeUrlKey(url), tabId = Number(details?.tabId ?? -1), meta = tabPageMeta.get(tabId) || null, payload = {
        kind: "network_request_capture",
        captured_at: nowIso(),
        request_id: details?.requestId || "",
        tab_id: tabId,
        frame_id: details?.frameId ?? -1,
        type: details?.type || "",
        method: details?.method || "GET",
        url: url,
        url_key: key,
        initiator: details?.initiator || details?.documentUrl || "",
        request_headers: headers
    };
    return meta && (payload.title = meta.title, payload.title_candidates = meta.title_candidates, 
    payload.episode = meta.episode, payload.season = meta.season, payload.page_url = meta.page_url), 
    requestCache.set(url, payload), key && requestCache.set(key, payload), trimCache(), 
    payload;
}

async function buildSetStreamPayload(details, payload, streamType) {
    let tabInfo = null;
    if ("number" == typeof details?.tabId && details.tabId >= 0) try {
        tabInfo = await chrome.tabs.get(details.tabId);
    } catch (_err) {
        tabInfo = null;
    }
    const tabId = Number(details?.tabId ?? -1), meta = tabPageMeta.get(tabId) || null, referer = deriveReferer(details, tabInfo), pageUrl = String(meta?.page_url || tabInfo?.url || details?.documentUrl || details?.initiator || referer || "").trim(), origin = deriveOrigin(referer || payload.url), metaTitle = String(meta?.title || "").trim(), tabTitle = String(tabInfo?.title || "").trim();
    let title = (tabTitle.length >= metaTitle.length ? tabTitle : metaTitle) || "Captured by Bridge Extension";
    const titleCandidates = Array.isArray(meta?.title_candidates) ? meta.title_candidates.map(item => {
        if (item && "object" == typeof item) {
            return {
                value: String(item.value || "").trim(),
                source: String(item.source || "unknown").trim()
            };
        }
        return {
            value: String(item || "").trim(),
            source: "unknown"
        };
    }).filter(item => item.value).slice(0, 30) : [];
    tabInfo?.title && titleCandidates.push({
        value: String(tabInfo.title).trim(),
        source: "title_tag"
    });
    const seenCandidates = new Set, dedupedTitleCandidates = [];
    for (const item of titleCandidates) {
        const key = `${item.value.toLowerCase()}::${item.source.toLowerCase()}`;
        seenCandidates.has(key) || (seenCandidates.add(key), dedupedTitleCandidates.push(item));
    }
    const episode = Number(meta?.episode || 0) || parseEpisodeFromText(pageUrl) || parseEpisodeFromText(title) || null, season = Number(meta?.season || 0) || parseSeasonFromText(pageUrl) || parseSeasonFromText(title) || null, detectedEpisode = extractEpisodeFromUrl(payload.url), headers = payload.request_headers || {}, headerMap = {};
    payload.url && (headerMap[payload.url] = headers), payload.url_key && (headerMap[payload.url_key] = headers);
    const masterCandidate = "hls" === streamType ? findRecentHlsMasterForTab(tabId, payload.url) : null;
    let hlsMasterUrl = payload.url;
    return "hls" === streamType && (payload.isMaster ? hlsMasterUrl = payload.url : masterCandidate && (hlsMasterUrl = masterCandidate.payload.url)), 
    {
        stream_url: payload.url,
        stream_type: streamType,
        referer: referer,
        page_url: pageUrl,
        origin: origin,
        user_agent: headers["user-agent"] || navigator.userAgent || "",
        request_headers: headers,
        url_header_map: headerMap,
        hls_master_url: "hls" === streamType ? hlsMasterUrl : "",
        subtitle_url: "",
        episode: episode || void 0,
        season: season || void 0,
        detected_episode: detectedEpisode,
        is_active_tab: tabId >= 0 && tabId === activeTabId,
        has_video: Boolean(meta?.has_video),
        video_count: Number(meta?.video_count || 0) || 0,
        title: title,
        title_candidates: dedupedTitleCandidates.slice(0, 30),
        tab_id: tabId
    };
}

function scoreStream(url, streamType) {
    if (!url || "string" != typeof url) return 0;
    const u = url.toLowerCase();
    let score = 0;
    return isHlsMasterUrl(u) && (score += 150), u.includes("master.m3u8") && (score += 50), 
    u.match(/index[^/]*\.m3u8/) && (score += 30), u.match(/\/hls\d*\//) && (score += 25), 
    u.match(/\/playlist\//) && (score += 20), u.match(/\/manifest\//) && (score += 20), 
    u.match(/1080p?|2160p?|4k/) && (score += 200), u.match(/720p?/) && (score += 180), 
    u.match(/\/video\/|\/stream\//) && (score += 15), u.match(/\/ep(?:isode)?[\/_-]?\d/) && (score += 25), 
    u.match(/seg-\d|chunk|fragment/) && (score -= 30), u.match(/(^|[\/_-])audio[\/_-\d]/) && (score -= 40), 
    u.match(/preview|thumb|low|tiny/) && (score -= 20), "direct" !== streamType || u.match(/audio/) || (score += 5), 
    score;
}

function rememberTabPrimaryCandidate(details, payload, streamType) {
    const tabId = Number(details?.tabId ?? -1);
    if (tabId < 0) return;
    if (!AUTO_STREAM_TYPES.has(streamType)) return;
    if ("direct" === streamType && isLikelyAudioDirectUrl(payload.url)) return;
    if ("hls" === streamType && !isPrimaryHlsUrl(payload.url)) return;
    const score = scoreStream(payload.url, streamType), newCandidate = {
        streamType: streamType,
        payload: payload,
        detailsLite: {
            tabId: tabId,
            initiator: details?.initiator || "",
            documentUrl: details?.documentUrl || ""
        },
        score: score,
        lastSeenAt: Date.now()
    }, existing = tabRecentPrimary.get(tabId);
    if (!existing) return tabRecentPrimary.set(tabId, {
        candidates: [ newCandidate ],
        bestIdx: 0
    }), void trimTabRecent();
    const {candidates: candidates} = existing, candidateKey = normalizeUrlKey(payload.url) || payload.url, duplicateIdx = candidates.findIndex(candidate => (normalizeUrlKey(candidate?.payload?.url) || candidate?.payload?.url) === candidateKey);
    if (duplicateIdx >= 0) return candidates[duplicateIdx] = newCandidate, existing.bestIdx = bestCandidateIndex(candidates), 
    void trimTabRecent();
    if (candidates.length < 8) candidates.push(newCandidate); else {
        let minScore = 1 / 0, minIdx = -1;
        for (let i = 0; i < candidates.length; i++) candidates[i].score < minScore && (minScore = candidates[i].score, 
        minIdx = i);
        if (!(score > minScore)) return;
        candidates[minIdx] = newCandidate;
    }
    existing.bestIdx = bestCandidateIndex(candidates), trimTabRecent();
}

async function maybeSetStreamForActiveTab(tabId) {
    if ("number" != typeof tabId || tabId < 0) return;
    const entry = tabRecentPrimary.get(tabId);
    if (!entry || !entry.candidates || 0 === entry.candidates.length) return;
    const best = entry.candidates[entry.bestIdx ?? 0];
    if (!best || !best.payload || !best.streamType) return;
    if (!shouldSetFromTabSwitch(best.payload.url)) return;
    const fakeDetails = {
        tabId: tabId,
        initiator: best.detailsLite?.initiator || "",
        documentUrl: best.detailsLite?.documentUrl || ""
    }, setStreamBody = await buildSetStreamPayload(fakeDetails, best.payload, best.streamType);
    setStreamBody.capture_id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 
    setStreamBody.capture_timestamp = Date.now(), setStreamBody.capture_source = "tab_switch", 
    setStreamBody.capture_stage = "sync", setStreamBody.cooldown_key = normalizeUrlKey(best.payload.url) || best.payload.url, 
    postSetStream(setStreamBody), chrome.tabs.sendMessage(tabId, {
        type: "bridge_force_meta_update"
    }).catch(() => {}), logInfo("active-tab switch stream", best.streamType, best.payload.url, "score=" + best.score);
}

function normalizeMigakuExtensionId(value) {
    const text = String(value || "").trim().toLowerCase();
    return /^[a-p]{32}$/.test(text) ? text : "";
}

async function loadBridgeSettings() {
    return {
        migakuExtensionId: normalizeMigakuExtensionId((await chrome.storage.local.get({
            migakuExtensionId: DEFAULT_MIGAKU_EXTENSION_ID
        })).migakuExtensionId) || DEFAULT_MIGAKU_EXTENSION_ID
    };
}

function migakuPlayerUrl(migakuExtensionId) {
    return `chrome-extension://${migakuExtensionId}${MIGAKU_PLAYER_PATH}`;
}

async function findMigakuPlayerTab(migakuExtensionId) {
    const prefix = migakuPlayerUrl(migakuExtensionId);
    let tabs = [];
    try {
        tabs = await chrome.tabs.query({
            url: `${prefix}*`
        });
    } catch (_err) {
        tabs = [];
    }
    if (!tabs.length) {
        tabs = (await chrome.tabs.query({})).filter(tab => String(tab.url || "").startsWith(prefix));
    }
    return tabs[0] || null;
}

async function focusTab(tab) {
    if (!tab?.id) return null;
    try {
        await chrome.tabs.update(tab.id, {
            active: !0
        });
    } catch (_err) {}
    if ("number" == typeof tab.windowId && chrome.windows?.update) try {
        await chrome.windows.update(tab.windowId, {
            focused: !0
        });
    } catch (_err) {}
    return tab;
}

async function openMigakuPlayer() {
    const settings = await loadBridgeSettings(), url = migakuPlayerUrl(settings.migakuExtensionId), existing = await findMigakuPlayerTab(settings.migakuExtensionId);
    if (existing) return await focusTab(existing), {
        ok: !0,
        tabId: existing.id,
        url: url,
        reused: !0,
        settings: settings
    };
    return {
        ok: !0,
        tabId: (await chrome.tabs.create({
            url: url,
            active: !0
        })).id,
        url: url,
        reused: !1,
        settings: settings
    };
}

async function handleRuntimeMessage(message, sender) {
    if (message) {
        if ("bridge_open_popup" === message.type) return chrome.windows.create({
            url: chrome.runtime.getURL("popup.html"),
            type: "popup",
            width: 340,
            height: 265
        }), {
            ok: !0
        };
        if ("bridge_ext_page_meta" === message.type) {
            const tabId = Number(sender?.tab?.id ?? -1);
            if (tabId >= 0) {
                const page_url = String(message.page_url || "").trim(), title = String(message.title || "").trim(), raw_candidates = Array.isArray(message.title_candidates) ? message.title_candidates.map(item => {
                    if (item && "object" == typeof item) {
                        return {
                            value: String(item.value || "").trim(),
                            source: String(item.source || "unknown").trim()
                        };
                    }
                    return {
                        value: String(item || "").trim(),
                        source: "unknown"
                    };
                }).filter(item => item.value).slice(0, 30) : [], seenCandidates = new Set, title_candidates = [];
                for (const item of raw_candidates) {
                    const key = `${item.value.toLowerCase()}::${item.source.toLowerCase()}`;
                    seenCandidates.has(key) || (seenCandidates.add(key), title_candidates.push(item));
                }
                const episode = Number(message.episode || 0) || null, season = Number(message.season || 0) || null, cleanTitle = (tabPageMeta.get(tabId), 
                (title || "").toLowerCase().replace(/[^a-z0-9]/g, ""));
                message.is_top_frame ? (tabPageMeta.set(tabId, {
                    page_url: page_url,
                    title: title,
                    cleanTitle: cleanTitle,
                    title_candidates: title_candidates,
                    episode: episode,
                    season: season,
                    at: Date.now()
                }), trimTabMeta(), logDebug("page meta updated", tabId, tabPageMeta.get(tabId))) : logDebug("page meta skipped (iframe)", tabId, title), 
                postCaptureEvent({
                    event_type: "page_meta",
                    tab_id: tabId,
                    page_url: page_url,
                    title: title,
                    title_candidates: title_candidates,
                    episode: episode,
                    season: season,
                    has_video: Boolean(message.has_video),
                    video_count: Number(message.video_count || 0) || 0,
                    is_top_frame: Boolean(message.is_top_frame),
                    frame_url: message.frame_url,
                    perf_now: message.perf_now
                });
            }
            return {
                ok: !0
            };
        }
        if ("bridge_open_migaku_player" === message.type || "open_migaku_player" === message.type) return await openMigakuPlayer();
        if ("bridge_ext_page_hook" === message.type) {
            const tabId = Number(sender?.tab?.id ?? -1), streamType = inferStreamType(message.url);
            if ("other" === streamType) return logInfo("DOM HOOK rejected (not a stream)", message.url), 
            {
                ok: !1
            };
            const primary = tabRecentPrimary.get(tabId), bestCandidate = primary?.candidates?.[primary?.bestIdx ?? 0], candidateAge = bestCandidate ? Date.now() - (bestCandidate.lastSeenAt || 0) : 1 / 0;
            if (bestCandidate && candidateAge < 25e3) return logInfo("DOM HOOK dropped (webRequest authoritative)", message.url, `candidateAge=${candidateAge}ms`), 
            {
                ok: !1,
                reason: "webRequest_authoritative"
            };
            if (!shouldSetStream(message.url, streamType, tabId)) return logInfo("DOM HOOK rate-limited/cooldown", message.url), 
            {
                ok: !1,
                reason: "cooldown"
            };
            const payload = buildPayload({
                url: message.url,
                method: message.method || "GET",
                tabId: tabId,
                type: "xmlhttprequest",
                isMaster: !!message.isMaster,
                initiator: message.pageUrl
            });
            logInfo("DOM HOOK set-stream", streamType, message.url);
            const fakeDetails = {
                tabId: tabId,
                initiator: message.pageUrl,
                documentUrl: message.pageUrl
            }, setStreamBody = await buildSetStreamPayload(fakeDetails, payload, streamType);
            return setStreamBody.capture_id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 
            setStreamBody.capture_timestamp = Date.now(), setStreamBody.capture_source = "hook", 
            setStreamBody.capture_stage = "best_candidate", setStreamBody.cooldown_key = normalizeUrlKey(message.url) || message.url, 
            postSetStream(setStreamBody), chrome.tabs.sendMessage(tabId, {
                type: "bridge_force_meta_update"
            }).catch(() => {}), {
                ok: !0
            };
        }
    }
}

function isNewerVersion(candidate, current) {
    const parseVersion = value => {
        const [core, prerelease = ""] = String(value || "").trim().replace(/^v/i, "").split("-", 2), parts = core.split(".").slice(0, 3).map(token => Number.parseInt(token, 10) || 0);
        for (;parts.length < 3; ) parts.push(0);
        return {
            parts: parts,
            prerelease: prerelease
        };
    }, next = parseVersion(candidate), active = parseVersion(current);
    for (let i = 0; i < 3; i++) if (next.parts[i] !== active.parts[i]) return next.parts[i] > active.parts[i];
    return Boolean(active.prerelease && !next.prerelease);
}

async function checkUpstreamUpdate() {
    try {
        const currentVersion = chrome.runtime.getManifest()?.version || "3.1.0", cached = await chrome.storage.local.get([ "upstreamVersion", "downloadUrl", "lastUpdateCheck" ]), now = Date.now();
        let version = cached?.upstreamVersion;
        if (!version || now - (cached?.lastUpdateCheck || 0) > 432e5) {
            const resp = await fetch("https://raw.githubusercontent.com/Zielzy/M-Stream-Bridge/main/index.min.json", {
                cache: "no-store"
            });
            if (resp.ok) {
                const data = await resp.json();
                data?.version && (version = data.version, await chrome.storage.local.set({
                    upstreamVersion: version,
                    downloadUrl: data.download_url || "https://github.com/Zielzy/M-Stream-Bridge/releases/latest",
                    lastUpdateCheck: now
                }));
            }
        }
        version && isNewerVersion(version, currentVersion) ? chrome.action?.setBadgeText && (chrome.action.setBadgeText({
            text: "UP"
        }), chrome.action.setBadgeBackgroundColor({
            color: "#7c3aed"
        })) : chrome.action?.setBadgeText && chrome.action.setBadgeText({
            text: ""
        });
    } catch (_e) {}
}

chrome.webRequest.onBeforeSendHeaders.addListener(async details => {
    if (!isAllowedRequestType(details?.type)) return;
    if (!isInterestingUrl(details?.url)) return;
    if (isSegmentLikeUrl(details?.url)) return;
    const payload = buildPayload(details), streamType = inferStreamType(payload.url);
    shouldPostCapture(payload.url, streamType) && postCapture(payload), rememberTabPrimaryCandidate(details, payload, streamType);
    const requestTabId = Number(details?.tabId ?? -1);
    if (activeTabId >= 0 && requestTabId >= 0 && requestTabId !== activeTabId) return;
    if ("hls" === streamType && shouldDeferHlsVariantToMaster(requestTabId, payload.url)) return;
    if (!shouldSetStream(payload.url, streamType, requestTabId)) return;
    logInfo("set-stream", streamType, payload.url, "score=" + scoreStream(payload.url, streamType));
    const setStreamBody = await buildSetStreamPayload(details, payload, streamType);
    setStreamBody.capture_id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 
    setStreamBody.capture_timestamp = Date.now(), setStreamBody.capture_source = "webRequest_beforeSendHeaders", 
    setStreamBody.capture_stage = "network", setStreamBody.cooldown_key = normalizeUrlKey(payload.url) || payload.url, 
    postSetStream(setStreamBody), details.tabId >= 0 && chrome.tabs.sendMessage(details.tabId, {
        type: "bridge_force_meta_update"
    }).catch(() => {});
}, {
    urls: [ "<all_urls>" ]
}, [ "requestHeaders", "extraHeaders" ]), chrome.webRequest.onCompleted.addListener(async details => {
    const url = details?.url || "";
    if (!url) return;
    if (isBridgeLocalUrl(url)) return;
    if (!isAllowedRequestType(details?.type)) return;
    if (isStaticNoiseUrl(url)) return;
    if (isSegmentLikeUrl(url)) return;
    if (requestCache.has(url)) return;
    const normalizedKey = normalizeUrlKey(url);
    if (normalizedKey && requestCache.has(normalizedKey)) return;
    const responseHeaders = details.responseHeaders || [], contentTypeHeader = responseHeaders.find(h => "content-type" === (h.name || "").toLowerCase()), contentType = contentTypeHeader?.value || "";
    if (!isStreamContentType(contentType)) return;
    logInfo("onCompleted stream detected", url, "ct=" + contentType);
    const cachedPayload = requestCache.get(normalizedKey) || requestCache.get(url), requestHeaders = cachedPayload?.request_headers || {}, payload = {
        kind: "network_request_capture",
        captured_at: nowIso(),
        request_id: details?.requestId || "",
        tab_id: details?.tabId ?? -1,
        frame_id: details?.frameId ?? -1,
        type: details?.type || "",
        method: details?.method || "GET",
        url: url,
        url_key: normalizedKey,
        initiator: details?.initiator || details?.documentUrl || "",
        request_headers: requestHeaders
    };
    requestCache.set(url, payload), normalizedKey && requestCache.set(normalizedKey, payload), 
    trimCache(), postCapture(payload);
    let streamType = inferStreamType(url);
    if ("other" === streamType) {
        const ctLower = contentType.toLowerCase();
        if (ctLower.includes("mpegurl")) streamType = "hls"; else if (ctLower.includes("mp4") || ctLower.includes("webm")) streamType = "direct"; else {
            if (!ctLower.includes("octet-stream")) return;
            streamType = "direct";
        }
    }
    if ("direct" === streamType && isLikelyAudioDirectUrl(url)) return;
    if ("hls" === streamType && !isPrimaryHlsUrl(url)) return;
    rememberTabPrimaryCandidate(details, payload, streamType);
    const requestTabId = Number(details?.tabId ?? -1);
    if (activeTabId >= 0 && requestTabId >= 0 && requestTabId !== activeTabId) return;
    if ("hls" === streamType && shouldDeferHlsVariantToMaster(requestTabId, url)) return;
    if (!shouldSetStream(url, streamType, requestTabId)) return;
    const refererHeader = responseHeaders.find(h => "referer" === (h.name || "").toLowerCase()), fakeDetails = {
        tabId: details?.tabId ?? -1,
        initiator: details?.initiator || refererHeader?.value || "",
        documentUrl: details?.documentUrl || "",
        requestHeaders: []
    };
    logInfo("onCompleted set-stream", streamType, url, "score=" + scoreStream(url, streamType));
    const setStreamBody = await buildSetStreamPayload(fakeDetails, payload, streamType);
    setStreamBody.capture_id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 
    setStreamBody.capture_timestamp = Date.now(), setStreamBody.capture_source = "webRequest_onCompleted", 
    setStreamBody.capture_stage = "network", setStreamBody.cooldown_key = normalizeUrlKey(payload.url) || payload.url, 
    postSetStream(setStreamBody), details.tabId >= 0 && chrome.tabs.sendMessage(details.tabId, {
        type: "bridge_force_meta_update"
    }).catch(() => {});
}, {
    urls: [ "<all_urls>" ]
}, [ "responseHeaders", "extraHeaders" ]), chrome.runtime.onInstalled.addListener(() => {
    logInfo("installed", "v3.1.0"), checkUpstreamUpdate();
}), chrome.runtime.onStartup.addListener(() => {
    checkUpstreamUpdate();
}), chrome.tabs.onActivated.addListener(async activeInfo => {
    activeTabId = Number(activeInfo?.tabId ?? -1), await maybeSetStreamForActiveTab(activeTabId);
}), chrome.tabs.onRemoved.addListener(tabId => {
    tabRecentPrimary.delete(tabId), tabPageMeta.delete(tabId);
}), chrome.tabs.query({
    active: !0,
    currentWindow: !0
}, tabs => {
    const first = Array.isArray(tabs) && tabs.length ? tabs[0] : null;
    activeTabId = Number(first?.id ?? -1);
}), chrome.runtime.onMessage.addListener((message, sender, sendResponse) => (handleRuntimeMessage(message, sender).then(response => {
    sendResponse(void 0 === response ? {
        ok: !1,
        error: "unknown message"
    } : response);
}).catch(err => {
    sendResponse({
        ok: !1,
        error: err?.message || String(err)
    });
}), !0));
