const BRIDGE_ORIGIN = "http://localhost:7000";
const CAPTURE_ENDPOINT = `${BRIDGE_ORIGIN}/capture-request`;
const SET_STREAM_ENDPOINT = `${BRIDGE_ORIGIN}/set-stream`;
const MIGAKU_PLAYER_URL = "chrome-extension://dmeppfcidcpcocleneopiblmpnbokhep/pages/player/index.html";

const INTERESTING_TYPES = new Set(["media", "xmlhttprequest", "fetch", "sub_frame", "object"]);
const STREAM_COOLDOWN_MS = 8000;
const recentRequests = new Map();
const lastSetByKey = new Map();

function nowIso() {
  return new Date().toISOString();
}

function cleanHeaders(items = []) {
  const keep = new Set([
    "accept",
    "accept-language",
    "authorization",
    "cache-control",
    "cookie",
    "origin",
    "pragma",
    "range",
    "referer",
    "user-agent",
  ]);
  const out = {};
  for (const item of items) {
    const name = String(item?.name || "").toLowerCase();
    const value = String(item?.value || "").trim();
    if (keep.has(name) && value) out[name] = value.slice(0, 4096);
  }
  return out;
}

function normalizeKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch (_err) {
    return "";
  }
}

function hasStreamSignature(url) {
  return /\.(m3u8|mp4|webm|mkv|mov|m4v)(\?|$)/i.test(url)
    || /(master\.m3u8|playlist|manifest|\/hls\/|\/stream\/|videoplayback)/i.test(url);
}

function inferStreamType(url, contentType = "") {
  const text = `${url || ""} ${contentType || ""}`.toLowerCase();
  if (text.includes(".m3u8") || text.includes("mpegurl") || /\/(hls|playlist|manifest)\//i.test(text)) return "hls";
  if (/\.(mp4|webm|mkv|mov|m4v)(\?|$)/i.test(text) || text.includes("video/")) return "direct";
  return "other";
}

function shouldSkipUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return true;
  if (/\.(js|css|json|png|jpe?g|gif|svg|woff2?|map)(\?|$)/i.test(url)) return true;
  return !hasStreamSignature(url);
}

function shouldSetStream(url) {
  const key = normalizeKey(url) || url;
  const last = lastSetByKey.get(key) || 0;
  const now = Date.now();
  if (now - last < STREAM_COOLDOWN_MS) return false;
  lastSetByKey.set(key, now);
  return true;
}

async function postJson(endpoint, body) {
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch (_err) {
    // Server may be offline; capture resumes when it is available.
  }
}

function rememberCapture(details, headers) {
  const key = normalizeKey(details.url);
  const payload = {
    kind: "network_request_capture",
    captured_at: nowIso(),
    request_id: details.requestId || "",
    tab_id: details.tabId ?? -1,
    frame_id: details.frameId ?? -1,
    type: details.type || "",
    method: details.method || "GET",
    url: details.url,
    url_key: key,
    initiator: details.initiator || details.documentUrl || "",
    request_headers: headers,
  };
  recentRequests.set(details.url, payload);
  if (key) recentRequests.set(key, payload);
  if (recentRequests.size > 500) {
    for (const oldKey of recentRequests.keys()) {
      recentRequests.delete(oldKey);
      if (recentRequests.size <= 400) break;
    }
  }
  void postJson(CAPTURE_ENDPOINT, payload);
  return payload;
}

async function buildSetStreamPayload(details, capture, streamType) {
  let tab = null;
  try {
    if (details.tabId >= 0) tab = await chrome.tabs.get(details.tabId);
  } catch (_err) {
    tab = null;
  }

  const headers = capture.request_headers || {};
  const urlKey = capture.url_key || normalizeKey(capture.url);
  const headerMap = {};
  headerMap[capture.url] = headers;
  if (urlKey) headerMap[urlKey] = headers;

  return {
    stream_url: capture.url,
    stream_type: streamType,
    referer: headers.referer || details.initiator || details.documentUrl || tab?.url || "",
    page_url: tab?.url || details.documentUrl || details.initiator || "",
    origin: headers.origin || "",
    user_agent: headers["user-agent"] || navigator.userAgent || "",
    request_headers: headers,
    url_header_map: headerMap,
    hls_master_url: streamType === "hls" ? capture.url : "",
    title: tab?.title || "Captured by Bridge Extension",
    title_candidates: tab?.title ? [tab.title] : [],
  };
}

async function captureAndMaybeSet(details, contentType = "") {
  if (!INTERESTING_TYPES.has(String(details?.type || "").toLowerCase())) return;
  if (shouldSkipUrl(details.url)) return;

  const headers = cleanHeaders(details.requestHeaders || []);
  const capture = rememberCapture(details, headers);
  const streamType = inferStreamType(details.url, contentType);
  if (streamType === "other" || !shouldSetStream(details.url)) return;

  const body = await buildSetStreamPayload(details, capture, streamType);
  void postJson(SET_STREAM_ENDPOINT, body);
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    void captureAndMaybeSet(details);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (recentRequests.has(details.url) || recentRequests.has(normalizeKey(details.url))) return;
    const header = (details.responseHeaders || []).find((item) => String(item?.name || "").toLowerCase() === "content-type");
    if (!header || inferStreamType(details.url, header.value) === "other") return;
    void captureAndMaybeSet({ ...details, requestHeaders: [] }, header.value);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

async function openMigakuPlayer() {
  const existing = await chrome.tabs.query({ url: `${MIGAKU_PLAYER_URL}*` });
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (typeof existing[0].windowId === "number") {
      try {
        await chrome.windows.update(existing[0].windowId, { focused: true });
      } catch (_err) {}
    }
    return { ok: true, reused: true, url: MIGAKU_PLAYER_URL };
  }
  const tab = await chrome.tabs.create({ url: MIGAKU_PLAYER_URL, active: true });
  return { ok: true, reused: false, tabId: tab.id, url: MIGAKU_PLAYER_URL };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "bridge_open_migaku_player") {
    sendResponse({ ok: false, error: "unknown message" });
    return false;
  }
  openMigakuPlayer()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});
