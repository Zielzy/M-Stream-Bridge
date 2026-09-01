// ==M-Stream Bridge==
// @name        M-Stream Bridge
// @version     __VERSION__
// @author      Zielzy
// @description Local bridge for non-DRM browser streams and Migaku Player.
// @homepage    https://github.com/Zielzy/M-Stream-Bridge
// ==/M-Stream Bridge==

/**
 * M-Stream Bridge - Background Service Worker (service_worker.js)
 *
 * Functions as the background worker controller for the extension to:
 * 1. Intercept and inspect browser HTTP/HTTPS network traffic in real-time.
 * 2. Identify HLS manifest files (.m3u8) or direct video files (.mp4, etc.) via URL & Content-Type analysis.
 * 3. Filter & grade captured stream URLs to select the best resolution candidate.
 * 4. Forward request headers, cookies, referer, UA, and media titles to local bridge server (`main.py`) via `/set-stream`.
 * 5. Track active tab state and automate stream re-delivery upon tab switching.
 */

// ==========================================================================
// 1. Lifecycle Installation & Imports
// ==========================================================================

self.addEventListener("install", () => {
  self.skipWaiting();
});

import "./shared/utils.js";
const { parseEpisodeFromText, parseSeasonFromText, extractEpisodeFromUrl } = globalThis.BridgeUtils;

// ==========================================================================
// 2. Configuration Constants & Runtime State Maps
// ==========================================================================

const BRIDGE_ORIGIN = "http://127.0.0.1:7000";
const CAPTURE_ENDPOINT = `${BRIDGE_ORIGIN}/capture-request`;
const CAPTURE_EVENT_ENDPOINT = `${BRIDGE_ORIGIN}/capture-event`;
const SET_STREAM_ENDPOINT = `${BRIDGE_ORIGIN}/set-stream`;
const LOG_PREFIX = "[BRIDGE-EXT]";
const LOG_LEVEL = "info";

const DEFAULT_MIGAKU_EXTENSION_ID = "dmeppfcidcpcocleneopiblmpnbokhep";
const MIGAKU_PLAYER_PATH = "/pages/player/index.html";

const MAX_HEADER_VALUE_LEN = 4096;
const MAX_CACHE_SIZE = 2000;
const MAX_COOLDOWN_KEYS = 1000;
const STREAM_SET_COOLDOWN_HLS_MS = 30000;
const STREAM_SET_COOLDOWN_DIRECT_MS = 15000;
const STREAM_SET_COOLDOWN_TAB_MS = 3000;
const AUTO_STREAM_TYPES = new Set(["hls", "direct"]);
const ALLOWED_REQUEST_TYPES = new Set(["media", "xmlhttprequest", "fetch", "sub_frame", "object"]);

const TAB_RECENT_TTL_MS = 5 * 60 * 1000;
const TAB_SWITCH_SET_COOLDOWN_MS = 3000;
const TAB_META_TTL_MS = 10 * 60 * 1000;
const MAX_CANDIDATES_PER_TAB = 8;
const MAX_TAB_STATE_ENTRIES = 200;

const RESPONSE_STREAM_CONTENT_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/octet-stream",
  "video/mp4",
  "video/webm",
  "video/MP2T",
  "video/iso.segment",
  "video/x-m4v",
]);

const requestCache = new Map();
const lastSetByKey = new Map();
const tabRecentPrimary = new Map();
const tabPageMeta = new Map();
let activeTabId = -1;

/**
 * Evaluates whether logging is enabled for the specified level.
 * @param {string} level - Log level string.
 * @returns {boolean} True if logging is permitted.
 */
function shouldLog(level) {
  if (LOG_LEVEL === "silent") return false;
  if (LOG_LEVEL === "debug") return true;
  return level !== "debug";
}

function logDebug(...args) {
  if (shouldLog("debug")) console.debug(LOG_PREFIX, ...args);
}

function logInfo(...args) {
  if (shouldLog("info")) console.log(LOG_PREFIX, ...args);
}

function nowIso() {
  return new Date().toISOString();
}

// ==========================================================================
// 3. URL Classification & Noise Filtering Heuristics
// ==========================================================================

/**
 * Filters out static noise assets unrelated to media streams.
 * @param {string} url - Target URL.
 * @returns {boolean} True if static asset.
 */
function isStaticNoiseUrl(url) {
  return /\.(js|css|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|map)(\?|$)/i.test(url);
}

/**
 * Checks whether URL points to the local bridge server itself.
 * @param {string} url - Target URL.
 * @returns {boolean} True if bridge URL.
 */
function isBridgeLocalUrl(url) {
  const value = String(url || "").trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return port === "7000" && (host === "localhost" || host === "127.0.0.1" || host === "::1");
  } catch (_err) {
    return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):7000(?:\/|$)/i.test(value);
  }
}

/**
 * Checks whether URL points to a subtitle or closed-caption resource.
 * @param {string} url - Target URL.
 * @returns {boolean} True if subtitle resource.
 */
function isSubtitleLikeUrl(url) {
  const value = String(url || "").toLowerCase();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.toLowerCase();
    const query = parsed.search.toLowerCase();
    return (
      /\/(?:subtitles?|captions?|cc)(?:\/|$)/i.test(path) ||
      /(?:^|[_\-.])sub(?:[_\-.]|$)/i.test(path) ||
      /(?:^|[_\-.])(?:eng|jpn|japanese|ja)(?:[_\-.]sub|[_\-.]cc)/i.test(path) ||
      /\.(?:srt|vtt|ass|ssa)(?:$|[?#])/i.test(value) ||
      /(?:^|[?&])(?:subtitle|caption|sub|cc)=/i.test(query)
    );
  } catch (_err) {
    return (
      /\/(?:subtitles?|captions?|cc)(?:\/|$)/i.test(value) ||
      /\.(?:srt|vtt|ass|ssa)(?:$|[?#])/i.test(value)
    );
  }
}

/**
 * Checks whether a URL matches known video or streaming manifest patterns.
 * @param {string} url - Target URL.
 * @returns {boolean} True if media signature matched.
 */
function hasMediaSignature(url) {
  if (!url || typeof url !== "string") return false;
  if (isBridgeLocalUrl(url)) return false;
  if (isSubtitleLikeUrl(url)) return false;
  if (/\.(m3u8|m3u|ts|m4s|mp4|webm|mkv|mov|key)(\?|&|$)/i.test(url)) return true;
  if (/(videoplayback|master\.m3u8|index-.*\.m3u8|\/hls\d*\/|\/dash\/|\/stream\/|\/segment\/|\/dl\/|\/playlist\/|\/manifest\/|\/rendition\/)/i.test(url)) return true;
  if (/\/(?:m3|m3u8|play|hls|src|stream|video|token|embed|v|e)\/[A-Za-z0-9+/=_%\-]{40,}/i.test(url)) return true;
  return false;
}

/**
 * Filters whether a URL is interesting for inspection to minimize overhead.
 * @param {string} url - Target URL.
 * @returns {boolean} True if candidate for capture.
 */
function isInterestingUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (isBridgeLocalUrl(url)) return false;
  if (isSubtitleLikeUrl(url)) return false;
  if (!hasMediaSignature(url)) return false;
  if (isStaticNoiseUrl(url) && !/\.(m3u8|mpd)(\?|$)/i.test(url)) return false;
  if (/\.(html?|php|aspx?|jsp)(\?|$)/i.test(url)) return false;
  return true;
}

function isAllowedRequestType(requestType) {
  return ALLOWED_REQUEST_TYPES.has(String(requestType || "").toLowerCase());
}

/**
 * Infers stream classification from URL string.
 * @param {string} url - Target URL.
 * @returns {string} Classification ("hls" | "direct" | "other").
 */
function inferStreamType(url) {
  const lowered = String(url || "").toLowerCase();
  if (!lowered) return "other";

  if (lowered.includes(".m3u8") || /(\/manifest\/|\/playlist\/|master\.m3u8|index-.*\.m3u8|\/hls\d*\/|\/rendition\/)/i.test(lowered)) {
    return "hls";
  }
  if (
    lowered.includes("videoplayback") ||
    /\.(mp4|webm|mkv|mov|m4v)(\?|&|$)/i.test(lowered) ||
    /(\/dl\/|\/download\/)/i.test(lowered)
  ) {
    return "direct";
  }
  return "other";
}

/**
 * Identifies audio-only HLS URLs.
 * @param {string} url - Target URL.
 * @returns {boolean} True if audio stream.
 */
function isLikelyAudioHlsUrl(url) {
  const lowered = String(url || "").toLowerCase();
  if (!lowered) return false;

  if (/\/lang\/[a-z]{2,3}(?:\/|$)/i.test(lowered)) return true;
  if (/\/audio(?:\/|[-_]|$)|\/aud(?:\/|[-_]|$)/i.test(lowered)) return true;
  if (/(?:^|[\/._-])(tha|eng|jpn|jap|ind|spa|fre|fra|ger|deu|por|rus|ita|kor|chi|zho)(?:[\/._-]|$)/i.test(lowered)) {
    if (!/(master\.m3u8|index-v\d|\/video\/|1080|720|480|360)/i.test(lowered)) return true;
  }
  return false;
}

/**
 * Tests whether URL is a fragmented ts/m4s video segment chunk.
 * @param {string} url - Target URL.
 * @returns {boolean} True if chunk segment.
 */
function isSegmentLikeUrl(url) {
  const lowered = String(url || "").toLowerCase();
  if (!lowered) return false;
  if (/\.(ts|m4s)(\?|$)/i.test(lowered)) return true;
  if (/(?:^|[\/._-])(seg(?:ment)?|chunk|frag(?:ment)?)(?:[\/._-]|\d|$)/i.test(lowered)) return true;
  return false;
}

/**
 * Ensures HLS URL is a main manifest (HLS Master/Index), not a segment or key file.
 * @param {string} url - Target URL.
 * @returns {boolean} True if primary manifest.
 */
function isPrimaryHlsUrl(url) {
  const lowered = String(url || "").toLowerCase();
  const hasM3u8 = lowered.includes(".m3u8");
  const hasHlsPath = /(\/hls\d*\/|\/playlist\/|\/manifest\/|\/rendition\/|\/dash\/)/i.test(lowered);
  if (!hasM3u8 && !hasHlsPath) return false;
  if (isLikelyAudioHlsUrl(lowered)) return false;
  if (/(seg-\d+|chunk|fragment)/i.test(lowered)) return false;
  if (hasM3u8 && /(encryption\.key|\/key\.|\.ts(\?|&|$)|\.m4s(\?|&|$)|\.jpg(\?|&|$)|\.html(\?|&|$))/i.test(lowered)) return false;
  return true;
}

function isHlsMasterUrl(url) {
  const lowered = String(url || "").toLowerCase();
  if (!lowered.includes(".m3u8")) return false;
  return /(^|\/)(master|index|playlist|manifest)[^/]*\.m3u8(?:[?#]|$)/i.test(lowered);
}

function isLikelyHlsVariantUrl(url) {
  const lowered = String(url || "").toLowerCase();
  if (!lowered.includes(".m3u8")) return false;
  if (isHlsMasterUrl(lowered)) return false;
  if (/(?:^|[\/._-])(?:1080|720|480|360|2160|4k|[0-9]{5,})(?:p)?[\/._-]?[^/]*\.m3u8(?:[?#]|$)/i.test(lowered)) return true;
  if (/(?:^|[\/._-])(?:video|rendition|variant)[\/._-]?[^/]*\.m3u8(?:[?#]|$)/i.test(lowered)) return true;
  return false;
}

function hlsSessionKey(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length <= 1) return parsed.origin;
    return `${parsed.origin}/${parts.slice(0, -1).join("/")}`;
  } catch (_err) {
    return "";
  }
}

/**
 * Filter preventing sending segment/junk requests to proxy server.
 * @param {string} url - Stream URL.
 * @param {string} streamType - Stream type classification.
 * @returns {boolean} True if capture should proceed.
 */
function shouldPostCapture(url, streamType) {
  const lowered = String(url || "").toLowerCase();
  if (!lowered) return false;

  if (isSegmentLikeUrl(lowered)) return false;
  if (/\.(ts|m4s|mp4|webm|mp3|aac)(\?|$)/i.test(lowered) && streamType !== "direct") return false;
  if (/(?:^|[?&])range=\d+-\d+/i.test(lowered) && streamType !== "direct") return false;

  if (streamType === "hls") {
    return isPrimaryHlsUrl(lowered);
  }
  if (streamType === "direct") {
    return !isLikelyAudioDirectUrl(lowered) && !isLikelyBackgroundVideoUrl(lowered);
  }
  if (streamType === "other" && isPrimaryHlsUrl(lowered)) return true;
  return false;
}

function isLikelyAudioDirectUrl(url) {
  const lowered = String(url || "").toLowerCase();
  if (!lowered) return false;
  const hasAudioCue = /(^|[\/_-])audio([\/_-]|\d|$)|\/audio\//i.test(lowered);
  const hasVideoCue = /(^|[\/_-])video([\/_-]|\d|$)|\/video\//i.test(lowered) || /(1080p|720p|480p|360p|itag=)/i.test(lowered);
  return hasAudioCue && !hasVideoCue;
}

function isLikelyBackgroundVideoUrl(url) {
  const lowered = String(url || "").toLowerCase();
  if (!lowered) return false;
  return /(background|bg-video|icon-|thumb|hover-video)/i.test(lowered);
}

function isStreamContentType(contentTypeValue) {
  if (!contentTypeValue) return false;
  const ct = contentTypeValue.toLowerCase().split(";")[0].trim();
  if (RESPONSE_STREAM_CONTENT_TYPES.has(ct)) return true;
  if (ct.includes("mpegurl") || ct.includes("mp2t") || ct.includes("m4v")) return true;
  return false;
}

// ==========================================================================
// 4. Header Sanitization & Cache Pruning Helpers
// ==========================================================================

function normalizeUrlKey(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_err) {
    return "";
  }
}

/**
 * Sanitizes headers by stripping hop-by-hop items and truncating length.
 * @param {Array} headers - Raw header items from webRequest.
 * @returns {Object} Cleaned header dictionary.
 */
function sanitizeHeaders(headers) {
  const out = {};
  if (!Array.isArray(headers)) return out;

  for (const item of headers) {
    const name = String(item?.name || "").trim().toLowerCase();
    if (!name) continue;
    if (["host", "content-length", "connection", "transfer-encoding"].includes(name)) continue;

    const value = String(item?.value || "").trim();
    if (!value) continue;
    out[name] = value.slice(0, MAX_HEADER_VALUE_LEN);
  }
  return out;
}

function trimCache() {
  if (requestCache.size <= MAX_CACHE_SIZE) return;
  const keys = requestCache.keys();
  while (requestCache.size > MAX_CACHE_SIZE) {
    const first = keys.next();
    if (first.done) break;
    requestCache.delete(first.value);
  }
}

function trimCooldownCache() {
  if (lastSetByKey.size <= MAX_COOLDOWN_KEYS) return;
  const keys = lastSetByKey.keys();
  while (lastSetByKey.size > MAX_COOLDOWN_KEYS) {
    const first = keys.next();
    if (first.done) break;
    lastSetByKey.delete(first.value);
  }
}

function trimTabRecent() {
  const now = Date.now();
  for (const [tabId, item] of tabRecentPrimary.entries()) {
    if (!item || !item.candidates || item.candidates.length === 0) {
      tabRecentPrimary.delete(tabId);
      continue;
    }
    item.candidates = item.candidates.filter((c) => c.lastSeenAt && now - c.lastSeenAt <= TAB_RECENT_TTL_MS);
    if (!item.candidates.length) {
      tabRecentPrimary.delete(tabId);
      continue;
    }
    item.bestIdx = bestCandidateIndex(item.candidates);
  }
  while (tabRecentPrimary.size > MAX_TAB_STATE_ENTRIES) {
    let oldestTabId = null;
    let oldestSeenAt = Infinity;
    for (const [tabId, item] of tabRecentPrimary.entries()) {
      const newestCandidateAt = Math.max(...item.candidates.map((candidate) => Number(candidate.lastSeenAt || 0)));
      if (newestCandidateAt < oldestSeenAt) {
        oldestSeenAt = newestCandidateAt;
        oldestTabId = tabId;
      }
    }
    if (oldestTabId === null) break;
    tabRecentPrimary.delete(oldestTabId);
  }
}

function trimTabMeta() {
  const now = Date.now();
  for (const [tabId, meta] of tabPageMeta.entries()) {
    if (!meta || !meta.at || now - meta.at > TAB_META_TTL_MS) {
      tabPageMeta.delete(tabId);
    }
  }
  while (tabPageMeta.size > MAX_TAB_STATE_ENTRIES) {
    let oldestTabId = null;
    let oldestAt = Infinity;
    for (const [tabId, meta] of tabPageMeta.entries()) {
      const at = Number(meta?.at || 0);
      if (at < oldestAt) {
        oldestAt = at;
        oldestTabId = tabId;
      }
    }
    if (oldestTabId === null) break;
    tabPageMeta.delete(oldestTabId);
  }
}

function bestCandidateIndex(candidates) {
  let bestScore = -Infinity;
  let bestIdx = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].score > bestScore) {
      bestScore = candidates[i].score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ==========================================================================
// 5. Bridge Proxy Dispatchers
// ==========================================================================

async function postCapture(payload) {
  try {
    const resp = await fetch(CAPTURE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    if (!resp.ok) {
      logDebug("capture rejected", resp.status, payload.url);
    }
  } catch (err) {
    logDebug("capture unavailable", String(err));
  }
}

async function postCaptureEvent(payload) {
  try {
    const resp = await fetch(CAPTURE_EVENT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    if (!resp.ok) {
      logDebug("capture event rejected", resp.status);
    }
  } catch (err) {
    logDebug("capture event unavailable", String(err));
  }
}

async function postSetStream(payload) {
  try {
    const resp = await fetch(SET_STREAM_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });

    if (!resp.ok) {
      logDebug("set-stream rejected", resp.status, payload.stream_url);
      return;
    }
    logInfo("set-stream ok", payload.stream_type, payload.stream_url, `s=${payload.season || "-"} ep=${payload.episode || "-"}`);
  } catch (err) {
    logDebug("set-stream unavailable", String(err));
  }
}

// ==========================================================================
// 6. Stream Cooldown & Duplicate Suppressors
// ==========================================================================

function deriveReferer(details, tabInfo) {
  const candidates = [details?.initiator || "", details?.documentUrl || "", tabInfo?.url || ""];
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

/**
 * Checks if stream is eligible for `/set-stream` under rate limiting.
 * @param {string} url - Target URL.
 * @param {string} streamType - Stream classification.
 * @param {number} tabId - Tab ID.
 * @returns {boolean} True if allowed.
 */
function shouldSetStream(url, streamType, tabId = -1) {
  if (!AUTO_STREAM_TYPES.has(streamType)) return false;
  if (isBridgeLocalUrl(url)) return false;
  if (isSubtitleLikeUrl(url)) return false;
  if (streamType === "direct" && isLikelyAudioDirectUrl(url)) return false;
  if (streamType === "hls" && !isPrimaryHlsUrl(url)) return false;

  const now = Date.now();
  const key = normalizeUrlKey(url) || url;

  // Layer 1: URL Cooldown
  const prev = lastSetByKey.get(key) || 0;
  const cooldownMs = streamType === "hls" ? STREAM_SET_COOLDOWN_HLS_MS : STREAM_SET_COOLDOWN_DIRECT_MS;
  if (now - prev < cooldownMs) {
    const elapsed = now - prev;
    const remaining = cooldownMs - elapsed;
    logDebug(`cooldown reject | layer=URL | source=webRequest | key=${key} | elapsed=${elapsed}ms | remaining=${remaining}ms`);
    return false;
  }

  // Layer 2: Tab-Host Cooldown
  if (tabId >= 0) {
    try {
      const parsed = new URL(url);
      const tabKey = `tab:${tabId}:host:${parsed.hostname}:type:${streamType}`;
      const tabPrev = lastSetByKey.get(tabKey) || 0;
      if (now - tabPrev < STREAM_SET_COOLDOWN_TAB_MS) {
        const elapsed = now - tabPrev;
        const remaining = STREAM_SET_COOLDOWN_TAB_MS - elapsed;
        logDebug(`cooldown reject | layer=TAB | source=webRequest | key=${tabKey} | elapsed=${elapsed}ms | remaining=${remaining}ms`);
        return false;
      }
      lastSetByKey.set(tabKey, now);
    } catch (_err) { }
  }

  lastSetByKey.set(key, now);
  trimCooldownCache();
  return true;
}

function shouldSetFromTabSwitch(url) {
  const key = `tab-switch:${normalizeUrlKey(url) || url}`;
  const now = Date.now();
  const prev = lastSetByKey.get(key) || 0;
  if (now - prev < TAB_SWITCH_SET_COOLDOWN_MS) return false;
  lastSetByKey.set(key, now);
  trimCooldownCache();
  return true;
}

function findRecentHlsMasterForTab(tabId, url) {
  if (typeof tabId !== "number" || tabId < 0) return null;
  const entry = tabRecentPrimary.get(tabId);
  if (!entry || !Array.isArray(entry.candidates)) return null;
  const targetSession = hlsSessionKey(url);
  let best = null;

  for (const candidate of entry.candidates) {
    const candidateUrl = String(candidate?.payload?.url || "");
    if (!candidateUrl || !isHlsMasterUrl(candidateUrl)) continue;
    if (targetSession && hlsSessionKey(candidateUrl) !== targetSession) continue;
    if (!best || Number(candidate.score || 0) > Number(best.score || 0)) {
      best = candidate;
    }
  }
  return best;
}

function shouldDeferHlsVariantToMaster(tabId, url) {
  return isLikelyHlsVariantUrl(url) && Boolean(findRecentHlsMasterForTab(tabId, url));
}

// ==========================================================================
// 7. Payload Builders
// ==========================================================================

function buildPayload(details) {
  const url = details?.url || "";
  const headers = sanitizeHeaders(details?.requestHeaders || []);
  const key = normalizeUrlKey(url);
  const tabId = Number(details?.tabId ?? -1);
  const meta = tabPageMeta.get(tabId) || null;

  const payload = {
    kind: "network_request_capture",
    captured_at: nowIso(),
    request_id: details?.requestId || "",
    tab_id: tabId,
    frame_id: details?.frameId ?? -1,
    type: details?.type || "",
    method: details?.method || "GET",
    url,
    url_key: key,
    initiator: details?.initiator || details?.documentUrl || "",
    request_headers: headers,
  };

  if (meta) {
    payload.title = meta.title;
    payload.title_candidates = meta.title_candidates;
    payload.episode = meta.episode;
    payload.season = meta.season;
    payload.page_url = meta.page_url;
  }

  requestCache.set(url, payload);
  if (key) requestCache.set(key, payload);
  trimCache();
  return payload;
}

async function buildSetStreamPayload(details, payload, streamType) {
  let tabInfo = null;
  if (typeof details?.tabId === "number" && details.tabId >= 0) {
    try {
      tabInfo = await chrome.tabs.get(details.tabId);
    } catch (_err) {
      tabInfo = null;
    }
  }

  const tabId = Number(details?.tabId ?? -1);
  const meta = tabPageMeta.get(tabId) || null;

  const referer = deriveReferer(details, tabInfo);
  const pageUrl = String(meta?.page_url || tabInfo?.url || details?.documentUrl || details?.initiator || referer || "").trim();
  const origin = deriveOrigin(referer || payload.url);

  const metaTitle = String(meta?.title || "").trim();
  const tabTitle = String(tabInfo?.title || "").trim();

  let title = (tabTitle.length >= metaTitle.length ? tabTitle : metaTitle) || "Captured by Bridge Extension";

  const titleCandidates = Array.isArray(meta?.title_candidates)
    ? meta.title_candidates
      .map((item) => {
        if (item && typeof item === "object") {
          const val = String(item.value || "").trim();
          const src = String(item.source || "unknown").trim();
          return { value: val, source: src };
        } else {
          return { value: String(item || "").trim(), source: "unknown" };
        }
      })
      .filter((item) => item.value)
      .slice(0, 30)
    : [];

  if (tabInfo?.title) {
    titleCandidates.push({ value: String(tabInfo.title).trim(), source: "title_tag" });
  }

  const seenCandidates = new Set();
  const dedupedTitleCandidates = [];
  for (const item of titleCandidates) {
    const key = `${item.value.toLowerCase()}::${item.source.toLowerCase()}`;
    if (!seenCandidates.has(key)) {
      seenCandidates.add(key);
      dedupedTitleCandidates.push(item);
    }
  }

  const episode = Number(meta?.episode || 0) || parseEpisodeFromText(pageUrl) || parseEpisodeFromText(title) || null;
  const season = Number(meta?.season || 0) || parseSeasonFromText(pageUrl) || parseSeasonFromText(title) || null;
  const detectedEpisode = extractEpisodeFromUrl(payload.url);

  const headers = payload.request_headers || {};
  const headerMap = {};
  if (payload.url) headerMap[payload.url] = headers;
  if (payload.url_key) headerMap[payload.url_key] = headers;
  const masterCandidate = streamType === "hls" ? findRecentHlsMasterForTab(tabId, payload.url) : null;
  let hlsMasterUrl = payload.url;
  if (streamType === "hls") {
    if (payload.isMaster) hlsMasterUrl = payload.url;
    else if (masterCandidate) hlsMasterUrl = masterCandidate.payload.url;
  }

  return {
    stream_url: payload.url,
    stream_type: streamType,
    referer,
    page_url: pageUrl,
    origin,
    user_agent: headers["user-agent"] || navigator.userAgent || "",
    request_headers: headers,
    url_header_map: headerMap,
    hls_master_url: streamType === "hls" ? hlsMasterUrl : "",
    subtitle_url: "",
    episode: episode || undefined,
    season: season || undefined,
    detected_episode: detectedEpisode,
    is_active_tab: tabId >= 0 && tabId === activeTabId,
    has_video: Boolean(meta?.has_video),
    video_count: Number(meta?.video_count || 0) || 0,
    title,
    title_candidates: dedupedTitleCandidates.slice(0, 30),
    tab_id: tabId,
  };
}

// ==========================================================================
// 8. Stream Scoring & Candidate Buffer Manager
// ==========================================================================

function scoreStream(url, streamType) {
  if (!url || typeof url !== "string") return 0;
  const u = url.toLowerCase();
  let score = 0;

  if (isHlsMasterUrl(u)) score += 150;
  if (u.includes("master.m3u8")) score += 50;
  if (u.match(/index[^/]*\.m3u8/)) score += 30;
  if (u.match(/\/hls\d*\//)) score += 25;
  if (u.match(/\/playlist\//)) score += 20;
  if (u.match(/\/manifest\//)) score += 20;
  if (u.match(/1080p?|2160p?|4k/)) score += 200;
  if (u.match(/720p?/)) score += 180;
  if (u.match(/\/video\/|\/stream\//)) score += 15;
  if (u.match(/\/ep(?:isode)?[\/_-]?\d/)) score += 25;

  if (u.match(/seg-\d|chunk|fragment/)) score -= 30;
  if (u.match(/(^|[\/_-])audio[\/_-\d]/)) score -= 40;
  if (u.match(/preview|thumb|low|tiny/)) score -= 20;
  if (streamType === "direct" && !u.match(/audio/)) score += 5;

  return score;
}

function rememberTabPrimaryCandidate(details, payload, streamType) {
  const tabId = Number(details?.tabId ?? -1);
  if (tabId < 0) return;
  if (!AUTO_STREAM_TYPES.has(streamType)) return;
  if (streamType === "direct" && isLikelyAudioDirectUrl(payload.url)) return;
  if (streamType === "hls" && !isPrimaryHlsUrl(payload.url)) return;

  const score = scoreStream(payload.url, streamType);
  const newCandidate = {
    streamType,
    payload,
    detailsLite: { tabId, initiator: details?.initiator || "", documentUrl: details?.documentUrl || "" },
    score,
    lastSeenAt: Date.now(),
  };

  const existing = tabRecentPrimary.get(tabId);

  if (!existing) {
    tabRecentPrimary.set(tabId, { candidates: [newCandidate], bestIdx: 0 });
    trimTabRecent();
    return;
  }

  const { candidates } = existing;
  const candidateKey = normalizeUrlKey(payload.url) || payload.url;
  const duplicateIdx = candidates.findIndex((candidate) => (
    (normalizeUrlKey(candidate?.payload?.url) || candidate?.payload?.url) === candidateKey
  ));

  if (duplicateIdx >= 0) {
    candidates[duplicateIdx] = newCandidate;
    existing.bestIdx = bestCandidateIndex(candidates);
    trimTabRecent();
    return;
  }

  if (candidates.length < MAX_CANDIDATES_PER_TAB) {
    candidates.push(newCandidate);
  } else {
    let minScore = Infinity;
    let minIdx = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].score < minScore) {
        minScore = candidates[i].score;
        minIdx = i;
      }
    }
    if (score > minScore) {
      candidates[minIdx] = newCandidate;
    } else {
      return;
    }
  }

  existing.bestIdx = bestCandidateIndex(candidates);
  trimTabRecent();
}

async function maybeSetStreamForActiveTab(tabId) {
  if (typeof tabId !== "number" || tabId < 0) return;
  const entry = tabRecentPrimary.get(tabId);
  if (!entry || !entry.candidates || entry.candidates.length === 0) return;
  const best = entry.candidates[entry.bestIdx ?? 0];
  if (!best || !best.payload || !best.streamType) return;
  if (!shouldSetFromTabSwitch(best.payload.url)) return;

  const fakeDetails = {
    tabId,
    initiator: best.detailsLite?.initiator || "",
    documentUrl: best.detailsLite?.documentUrl || "",
  };

  const setStreamBody = await buildSetStreamPayload(fakeDetails, best.payload, best.streamType);
  setStreamBody.capture_id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  setStreamBody.capture_timestamp = Date.now();
  setStreamBody.capture_source = "tab_switch";
  setStreamBody.capture_stage = "sync";
  setStreamBody.cooldown_key = normalizeUrlKey(best.payload.url) || best.payload.url;

  void postSetStream(setStreamBody);
  chrome.tabs.sendMessage(tabId, { type: "bridge_force_meta_update" }).catch(() => { });
  logInfo("active-tab switch stream", best.streamType, best.payload.url, "score=" + best.score);
}

// ==========================================================================
// 9. Migaku Extension Launcher Helpers
// ==========================================================================

function normalizeMigakuExtensionId(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-p]{32}$/.test(text) ? text : "";
}

async function loadBridgeSettings() {
  const stored = await chrome.storage.local.get({
    migakuExtensionId: DEFAULT_MIGAKU_EXTENSION_ID,
  });
  const migakuExtensionId = normalizeMigakuExtensionId(stored.migakuExtensionId) || DEFAULT_MIGAKU_EXTENSION_ID;
  return {
    migakuExtensionId,
  };
}

function migakuPlayerUrl(migakuExtensionId) {
  return `chrome-extension://${migakuExtensionId}${MIGAKU_PLAYER_PATH}`;
}

async function findMigakuPlayerTab(migakuExtensionId) {
  const prefix = migakuPlayerUrl(migakuExtensionId);
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: `${prefix}*` });
  } catch (_err) {
    tabs = [];
  }
  if (!tabs.length) {
    const allTabs = await chrome.tabs.query({});
    tabs = allTabs.filter((tab) => String(tab.url || "").startsWith(prefix));
  }
  return tabs[0] || null;
}

async function focusTab(tab) {
  if (!tab?.id) return null;
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch (_err) { }
  if (typeof tab.windowId === "number" && chrome.windows?.update) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (_err) { }
  }
  return tab;
}

async function openMigakuPlayer() {
  const settings = await loadBridgeSettings();
  const url = migakuPlayerUrl(settings.migakuExtensionId);
  const existing = await findMigakuPlayerTab(settings.migakuExtensionId);
  if (existing) {
    await focusTab(existing);
    return { ok: true, tabId: existing.id, url, reused: true, settings };
  }
  const tab = await chrome.tabs.create({ url, active: true });
  return { ok: true, tabId: tab.id, url, reused: false, settings };
}

// ==========================================================================
// 10. IPC Message Router & Chrome WebRequest / Tab Event Listeners
// ==========================================================================

async function handleRuntimeMessage(message, sender) {
  if (!message) return undefined;

  if (message.type === "bridge_open_popup") {
    chrome.windows.create({
      url: chrome.runtime.getURL("popup.html"),
      type: "popup",
      width: 340,
      height: 265,
    });
    return { ok: true };
  }

  if (message.type === "bridge_ext_page_meta") {
    console.debug("[Bridge] PAGE_META received from content script", {
      tabId: sender?.tab?.id,
      frameId: sender?.frameId,
      documentId: sender?.documentId,
      top: message.is_top_frame,
      href: message.frame_url,
    });

    const tabId = Number(sender?.tab?.id ?? -1);
    if (tabId >= 0) {
      const page_url = String(message.page_url || "").trim();
      const title = String(message.title || "").trim();
      const raw_candidates = Array.isArray(message.title_candidates)
        ? message.title_candidates
          .map((item) => {
            if (item && typeof item === "object") {
              const val = String(item.value || "").trim();
              const src = String(item.source || "unknown").trim();
              return { value: val, source: src };
            } else {
              return { value: String(item || "").trim(), source: "unknown" };
            }
          })
          .filter((item) => item.value)
          .slice(0, 30)
        : [];

      const seenCandidates = new Set();
      const title_candidates = [];
      for (const item of raw_candidates) {
        const key = `${item.value.toLowerCase()}::${item.source.toLowerCase()}`;
        if (!seenCandidates.has(key)) {
          seenCandidates.add(key);
          title_candidates.push(item);
        }
      }
      const episode = Number(message.episode || 0) || null;
      const season = Number(message.season || 0) || null;

      const existingMeta = tabPageMeta.get(tabId) || {};
      const cleanTitle = (title || "").toLowerCase().replace(/[^a-z0-9]/g, "");

      if (message.is_top_frame) {
        tabPageMeta.set(tabId, {
          page_url,
          title,
          cleanTitle,
          title_candidates,
          episode,
          season,
          at: Date.now(),
        });
        trimTabMeta();
        logDebug("page meta updated", tabId, tabPageMeta.get(tabId));
      } else {
        logDebug("page meta skipped (iframe)", tabId, title);
      }

      void postCaptureEvent({
        event_type: "page_meta",
        tab_id: tabId,
        page_url,
        title,
        title_candidates,
        episode,
        season,
        has_video: Boolean(message.has_video),
        video_count: Number(message.video_count || 0) || 0,
        is_top_frame: Boolean(message.is_top_frame),
        frame_url: message.frame_url,
        perf_now: message.perf_now,
      });
    }
    return { ok: true };
  }

  if (message.type === "bridge_open_migaku_player" || message.type === "open_migaku_player") {
    return await openMigakuPlayer();
  }

  if (message.type === "bridge_ext_page_hook") {
    const tabId = Number(sender?.tab?.id ?? -1);
    const streamType = inferStreamType(message.url);

    if (streamType === "other") {
      logInfo("DOM HOOK rejected (not a stream)", message.url);
      return { ok: false };
    }

    const payload = buildPayload({
      url: message.url,
      method: message.method || "GET",
      tabId: tabId,
      type: "xmlhttprequest",
      isMaster: !!message.isMaster,
      initiator: message.pageUrl,
    });

    logInfo("DOM HOOK set-stream", streamType, message.url);

    const fakeDetails = {
      tabId: tabId,
      initiator: message.pageUrl,
      documentUrl: message.pageUrl,
    };

    const setStreamBody = await buildSetStreamPayload(fakeDetails, payload, streamType);
    setStreamBody.capture_id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setStreamBody.capture_timestamp = Date.now();
    setStreamBody.capture_source = "hook";
    setStreamBody.capture_stage = "best_candidate";
    setStreamBody.cooldown_key = normalizeUrlKey(message.url) || message.url;

    void postSetStream(setStreamBody);
    chrome.tabs.sendMessage(tabId, { type: "bridge_force_meta_update" }).catch(() => { });
    return { ok: true };
  }

  return undefined;
}

// WebRequest: Intercept before request headers are sent
chrome.webRequest.onBeforeSendHeaders.addListener(
  async (details) => {
    if (!isAllowedRequestType(details?.type)) return;
    if (!isInterestingUrl(details?.url)) return;
    if (isSegmentLikeUrl(details?.url)) return;

    const payload = buildPayload(details);
    const streamType = inferStreamType(payload.url);

    if (shouldPostCapture(payload.url, streamType)) {
      void postCapture(payload);
    }

    rememberTabPrimaryCandidate(details, payload, streamType);

    const requestTabId = Number(details?.tabId ?? -1);
    if (activeTabId >= 0 && requestTabId >= 0 && requestTabId !== activeTabId) return;
    if (streamType === "hls" && shouldDeferHlsVariantToMaster(requestTabId, payload.url)) return;
    if (!shouldSetStream(payload.url, streamType, requestTabId)) return;

    logInfo("set-stream", streamType, payload.url, "score=" + scoreStream(payload.url, streamType));

    const setStreamBody = await buildSetStreamPayload(details, payload, streamType);
    setStreamBody.capture_id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setStreamBody.capture_timestamp = Date.now();
    setStreamBody.capture_source = "webRequest_beforeSendHeaders";
    setStreamBody.capture_stage = "network";
    setStreamBody.cooldown_key = normalizeUrlKey(payload.url) || payload.url;

    void postSetStream(setStreamBody);
    if (details.tabId >= 0) {
      chrome.tabs.sendMessage(details.tabId, { type: "bridge_force_meta_update" }).catch(() => { });
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// WebRequest: Inspect response headers upon completion
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const url = details?.url || "";
    if (!url) return;
    if (isBridgeLocalUrl(url)) return;
    if (!isAllowedRequestType(details?.type)) return;
    if (isStaticNoiseUrl(url)) return;
    if (isSegmentLikeUrl(url)) return;

    if (requestCache.has(url)) return;
    const normalizedKey = normalizeUrlKey(url);
    if (normalizedKey && requestCache.has(normalizedKey)) return;

    const responseHeaders = details.responseHeaders || [];
    const contentTypeHeader = responseHeaders.find(
      (h) => (h.name || "").toLowerCase() === "content-type"
    );
    const contentType = contentTypeHeader?.value || "";
    if (!isStreamContentType(contentType)) return;

    logInfo("onCompleted stream detected", url, "ct=" + contentType);

    const cachedPayload = requestCache.get(normalizedKey) || requestCache.get(url);
    const requestHeaders = cachedPayload?.request_headers || {};

    const payload = {
      kind: "network_request_capture",
      captured_at: nowIso(),
      request_id: details?.requestId || "",
      tab_id: details?.tabId ?? -1,
      frame_id: details?.frameId ?? -1,
      type: details?.type || "",
      method: details?.method || "GET",
      url,
      url_key: normalizedKey,
      initiator: details?.initiator || details?.documentUrl || "",
      request_headers: requestHeaders,
    };

    requestCache.set(url, payload);
    if (normalizedKey) requestCache.set(normalizedKey, payload);
    trimCache();

    void postCapture(payload);

    let streamType = inferStreamType(url);
    if (streamType === "other") {
      const ctLower = contentType.toLowerCase();
      if (ctLower.includes("mpegurl")) streamType = "hls";
      else if (
        ctLower.includes("mp4") ||
        ctLower.includes("webm")
      ) streamType = "direct";
      else if (ctLower.includes("octet-stream")) streamType = "direct";
      else return;
    }

    if (streamType === "direct" && isLikelyAudioDirectUrl(url)) return;
    if (streamType === "hls" && !isPrimaryHlsUrl(url)) return;

    rememberTabPrimaryCandidate(details, payload, streamType);

    const requestTabId = Number(details?.tabId ?? -1);
    if (activeTabId >= 0 && requestTabId >= 0 && requestTabId !== activeTabId) return;
    if (streamType === "hls" && shouldDeferHlsVariantToMaster(requestTabId, url)) return;
    if (!shouldSetStream(url, streamType, requestTabId)) return;

    const refererHeader = responseHeaders.find(
      (h) => (h.name || "").toLowerCase() === "referer"
    );
    const fakeDetails = {
      tabId: details?.tabId ?? -1,
      initiator: details?.initiator || refererHeader?.value || "",
      documentUrl: details?.documentUrl || "",
      requestHeaders: [],
    };

    logInfo("onCompleted set-stream", streamType, url, "score=" + scoreStream(url, streamType));
    const setStreamBody = await buildSetStreamPayload(fakeDetails, payload, streamType);
    setStreamBody.capture_id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setStreamBody.capture_timestamp = Date.now();
    setStreamBody.capture_source = "webRequest_onCompleted";
    setStreamBody.capture_stage = "network";
    setStreamBody.cooldown_key = normalizeUrlKey(payload.url) || payload.url;

    void postSetStream(setStreamBody);
    if (details.tabId >= 0) {
      chrome.tabs.sendMessage(details.tabId, { type: "bridge_force_meta_update" }).catch(() => { });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

chrome.runtime.onInstalled.addListener(() => {
  logInfo("installed", "v__VERSION__");
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  activeTabId = Number(activeInfo?.tabId ?? -1);
  await maybeSetStreamForActiveTab(activeTabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabRecentPrimary.delete(tabId);
  tabPageMeta.delete(tabId);
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const first = Array.isArray(tabs) && tabs.length ? tabs[0] : null;
  activeTabId = Number(first?.id ?? -1);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, sender)
    .then((response) => {
      sendResponse(response === undefined ? { ok: false, error: "unknown message" } : response);
    })
    .catch((err) => {
      sendResponse({
        ok: false,
        error: err?.message || String(err),
      });
    });
  return true;
});

