// ==M-Stream Bridge==
// @name        M-Stream Bridge
// @version     __VERSION__
// @author      Zielzy
// @description Local bridge for non-DRM browser streams and Migaku Player.
// @homepage    https://github.com/Zielzy/M-Stream-Bridge
// ==/M-Stream Bridge==

/**
 * M-Stream Bridge - Popup JS (popup.js)
 *
 * Manages UI interactions for the extension popup window:
 * 1. Periodically performs health checks against the local bridge server.
 * 2. Fetches active stream metadata from `/api/current-stream` and renders it.
 * 3. Provides shortcut buttons to open or focus the Migaku Local Player tab.
 */

// ==========================================================================
// 1. Constants & Configuration
// ==========================================================================

const BRIDGE_ORIGIN = "http://127.0.0.1:7000";
const DEFAULT_MIGAKU_EXTENSION_ID = "dmeppfcidcpcocleneopiblmpnbokhep";
const MIGAKU_PLAYER_PATH = "/pages/player/index.html";

const HEALTH_RETRY_COUNT = 3;
const HEALTH_RETRY_DELAY_MS = 350;
const RECENT_ONLINE_GRACE_MS = 2500; // Grace period before marking server offline

// ==========================================================================
// 2. DOM Element Selectors & State Variables
// ==========================================================================

let latestState = null;
let toastTimer = null;
let lastServerOnlineAt = 0;

const el = {
  pill: document.getElementById("stream-pill"),
  season: document.getElementById("stream-season"),
  episode: document.getElementById("stream-episode"),
  title: document.getElementById("stream-title"),
  url: document.getElementById("stream-url"),
  status: document.getElementById("status"),
  openMigaku: document.getElementById("btn-open-migaku"),
  serverDot: document.getElementById("server-dot"),
  serverLine: document.getElementById("server-line"),
  serverBadge: document.getElementById("server-badge"),
  toast: document.getElementById("toast"),
};

// ==========================================================================
// 3. UI Helper & Toast Functions
// ==========================================================================

/**
 * Displays a floating toast message at the top/bottom of the popup.
 * @param {string} message - Toast message text.
 */
function showToast(message) {
  if (!el.toast) return;
  el.toast.textContent = message;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 1400);
}

/**
 * Updates the main connection status text at the bottom of the popup.
 * @param {boolean} ok - Success status flag.
 * @param {string} text - Status descriptive message.
 */
function setStatus(ok, text) {
  if (!el.status) return;
  const dotClass = ok ? "ok" : "bad";
  el.status.innerHTML = `<span class="status-dot ${dotClass}"></span> <span class="status-text">${text}</span>`;
}

/**
 * Toggles the ONLINE / OFFLINE badge indicator in popup header.
 * @param {boolean} online - Server connection state.
 */
function setServerIndicator(online) {
  if (el.serverLine) {
    el.serverLine.textContent = new URL(BRIDGE_ORIGIN).host;
  }
  if (el.serverDot) {
    el.serverDot.classList.toggle("online", online);
  }
  if (!el.serverBadge) return;
  el.serverBadge.textContent = online ? "ONLINE" : "OFFLINE";
  el.serverBadge.classList.toggle("online", online);
  el.serverBadge.classList.toggle("offline", !online);
}

/**
 * Validates and normalizes input into a positive integer (>= 1).
 * @param {*} value - Input value.
 * @returns {number|null} Normalized integer or null.
 */
function normalizePositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

/**
 * Renders Season and Episode badges in popup.
 * @param {number|null} season - Season number.
 * @param {number|null} episode - Episode number.
 */
function renderSeasonEpisode(season, episode) {
  if (el.season) {
    if (season) {
      el.season.textContent = `S${String(season).padStart(2, "0")}`;
      el.season.style.display = "inline-flex";
    } else {
      el.season.style.display = "none";
    }
  }
  if (el.episode) {
    if (episode) {
      el.episode.textContent = `EP${String(episode).padStart(2, "0")}`;
      el.episode.style.display = "inline-flex";
    } else {
      el.episode.style.display = "none";
    }
  }
}

/**
 * Shortens long URLs for compact display in popup.
 * @param {string} url - Source stream URL.
 * @returns {string} Shortened string.
 */
function compactUrl(url) {
  if (!url) return "-";
  const s = String(url);
  return s.length > 55 ? s.slice(0, 52) + "..." : s;
}

/**
 * Applies active stream data from API to popup DOM elements.
 * @param {Object|null} streamData - Stream metadata payload.
 * @param {string} playbackUrl - Formatted playback proxy URL.
 */
function applyStream(streamData, playbackUrl) {
  const stream = streamData || {};
  const streamType = String(stream.stream_type || "hls").toLowerCase();
  const streamUrl = stream.stream_url || stream.m3u8_url || "";

  // Priority: Display clean_title over raw title
  const title = stream.clean_title || stream.display_title || stream.title || "Captured by Bridge Extension";
  const season = normalizePositiveInt(stream.season);
  const episode = normalizePositiveInt(stream.episode) || normalizePositiveInt(stream.detected_episode);

  if (streamUrl) {
    el.pill.textContent = streamType === "direct" ? "DIRECT" : "HLS";
    el.pill.classList.toggle("direct", streamType === "direct");
    el.pill.classList.toggle("hls", streamType !== "direct");
    el.pill.style.display = "inline-flex";
  } else {
    el.pill.style.display = "none";
  }
  el.title.textContent = title;
  el.url.textContent = compactUrl(streamUrl);
  renderSeasonEpisode(season, episode);

  latestState = {
    streamType,
  };
}

// ==========================================================================
// 4. Network & Retry Handlers
// ==========================================================================

/**
 * Fetches JSON payload bypassing cache.
 * @param {string} url - Target URL.
 * @returns {Promise<Object>} JSON response payload.
 */
async function fetchJson(url) {
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}

/**
 * Delay helper for retry intervals.
 * @param {number} ms - Milliseconds to sleep.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches JSON with automatic retry attempts.
 * @param {string} url - Target URL.
 * @param {number} attempts - Maximum attempt count.
 * @returns {Promise<Object>} JSON response payload.
 */
async function fetchJsonWithRetry(url, attempts = HEALTH_RETRY_COUNT) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetchJson(url);
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await sleep(HEALTH_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError || new Error("fetch failed");
}

// ==========================================================================
// 5. Chrome Runtime & Extension Store Helpers
// ==========================================================================

/**
 * Dispatches a runtime message to background Service Worker.
 * @param {Object} message - Message payload.
 * @returns {Promise<*>} Service worker response.
 */
function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Wraps Chrome callback APIs into Promises.
 * @param {Function} fn - API call taking a callback.
 * @returns {Promise<*>} Result from callback.
 */
function chromeCallback(fn) {
  return new Promise((resolve, reject) => {
    fn((result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(result);
    });
  });
}

/**
 * Validates format of 32-character Chrome extension ID.
 * @param {string} value - Extension ID candidate.
 * @returns {string} Validated ID or empty string.
 */
function normalizeMigakuExtensionId(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-p]{32}$/.test(text) ? text : "";
}

/**
 * Loads Migaku extension ID from chrome.storage.local.
 * @returns {Promise<string>} Configured or default Migaku Extension ID.
 */
async function loadMigakuExtensionId() {
  try {
    const stored = await chromeCallback((done) => chrome.storage.local.get({ migakuExtensionId: DEFAULT_MIGAKU_EXTENSION_ID }, done));
    return normalizeMigakuExtensionId(stored?.migakuExtensionId) || DEFAULT_MIGAKU_EXTENSION_ID;
  } catch (_err) {
    return DEFAULT_MIGAKU_EXTENSION_ID;
  }
}

/**
 * Fallback to directly query or create Migaku Player tab if service worker is idle.
 * @returns {Promise<Object>} Status object.
 */
async function openMigakuPlayerDirect() {
  const id = await loadMigakuExtensionId();
  const url = `chrome-extension://${id}${MIGAKU_PLAYER_PATH}`;
  try {
    const tabs = await chromeCallback((done) => chrome.tabs.query({ url: `${url}*` }, done));
    const existing = Array.isArray(tabs) ? tabs[0] : null;
    if (existing?.id != null) {
      if (existing.windowId != null && chrome.windows?.update) {
        try {
          await chromeCallback((done) => chrome.windows.update(existing.windowId, { focused: true }, done));
        } catch (_err) { }
      }
      await chromeCallback((done) => chrome.tabs.update(existing.id, { active: true }, done));
      return { ok: true, reused: true, url };
    }
  } catch (_err) { }
  const tab = await chromeCallback((done) => chrome.tabs.create({ url, active: true }, done));
  return { ok: true, reused: false, tabId: tab?.id, url };
}

// ==========================================================================
// 6. Migaku Player Launcher & Action Handlers
// ==========================================================================

/**
 * Syncs connection status and renders active stream from local server to popup UI.
 */
async function refreshState() {
  try {
    setStatus(true, "Verifying bridge connection...");
    await fetchJsonWithRetry(`${BRIDGE_ORIGIN}/health`);
    lastServerOnlineAt = Date.now();
    setServerIndicator(true);

    const data = await fetchJsonWithRetry(`${BRIDGE_ORIGIN}/api/current-stream`, 2);
    const hasStream = Boolean(data?.has_stream);
    applyStream(data?.stream || null, data?.playback_url || "");

    if (hasStream) {
      setStatus(true, `Bridge ready. Streaming ${latestState.streamType.toUpperCase()} feed...`);
    } else {
      setStatus(true, "Bridge active. Awaiting media stream...");
    }
  } catch (err) {
    // If recently online, allow startup delay grace period
    if (Date.now() - lastServerOnlineAt < RECENT_ONLINE_GRACE_MS) {
      setStatus(true, "Bridge server is initializing...");
      return;
    }
    setServerIndicator(false);
    latestState = null;
    renderSeasonEpisode(null, null);
    if (el.pill) el.pill.style.display = "none";
    el.title.textContent = "Bridge offline";
    el.url.textContent = "Run M-Stream Bridge.exe";
    setStatus(false, "Bridge offline. Please launch the desktop app.");
  }
}

/**
 * Requests Service Worker to open or focus Migaku local player.
 */
async function openMigakuPlayer() {
  setStatus(true, "Launching Migaku Local Player...");
  let resp = null;
  try {
    resp = await sendRuntimeMessage({ type: "bridge_open_migaku_player" });
    if (!resp?.ok && (resp?.error === "unknown_message" || resp?.error === "unknown message")) {
      resp = await sendRuntimeMessage({ type: "open_migaku_player" });
    }
  } catch (_err) { }

  if (!resp?.ok) {
    resp = await openMigakuPlayerDirect();
  }

  if (resp?.ok) {
    setStatus(true, resp.reused ? "Switched to active Migaku Player." : "Migaku Local Player launched.");
    showToast(resp.reused ? "Focus Migaku" : "Open Migaku");
    return;
  }
  throw new Error(resp?.error || "Failed to open Migaku");
}

// ==========================================================================
// 7. Lifecycle Initialization & Event Listeners
// ==========================================================================

if (el.openMigaku) {
  el.openMigaku.addEventListener("click", async () => {
    try {
      await openMigakuPlayer();
    } catch (err) {
      setStatus(false, "Failed to launch Migaku Player.");
      showToast("Failed to open Migaku");
    }
  });
}

void refreshState();

