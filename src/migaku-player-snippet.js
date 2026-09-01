// ==M-Stream Bridge==
// @name        M-Stream Bridge
// @version     __VERSION__
// @author      Zielzy
// @description Local bridge for non-DRM browser streams and Migaku Player.
// @homepage    https://github.com/Zielzy/M-Stream-Bridge
// ==/M-Stream Bridge==

/**
 * M-Stream Bridge - Client Side Injection Snippet
 *
 * This script is injected into the Migaku Player tab to:
 * 1. Create a modern overlay control panel (Proxy, Direct, Subtitle).
 * 2. Manipulate HTMLMediaElement objects to support custom duration (essential for HLS live streams).
 * 3. Bootstrap the native Migaku player by generating a 1-second dummy WebM video
 *    in memory and simulating file drop to force Migaku to load the <video> element.
 * 4. Download subtitles from the bridge server and simulate automatic drag-and-drop
 *    into Migaku's dropzone / file-input.
 */
(function () {
  "use strict";

  const VERSION = "__VERSION__";
  const BRIDGE_ORIGIN = "http://127.0.0.1:7000";
  const PANEL_ID = "__bridge_migaku_console_panel__";
  const STATE_KEY = "__bridge_migaku_console_state__";
  const POS_STORAGE_KEY = "__bridge_migaku_panel_pos__";

  // Bootstrap dummy video configuration
  const DUMMY_DURATION_MS = 1000;
  const DUMMY_AUDIO_GAIN = 0.002;
  const AUTO_SYNC_INTERVAL_MS = 10000;

  // ==========================================================================
  // 1. Override Default HTMLMediaElement Duration
  // ==========================================================================
  // Useful because HLS / Live Streams often return Infinity or 0 duration.
  // Without this modification, video players (and Migaku) cannot seek or rewind.
  if (!window.__bridgeDurationOverrideApplied) {
    window.__bridgeDurationOverrideApplied = true;
    try {
      const origDesc = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, "duration");
      if (origDesc && origDesc.get) {
        Object.defineProperty(window.HTMLMediaElement.prototype, "duration", {
          get: function () {
            const val = origDesc.get.call(this);
            // If original duration is invalid (Infinity, NaN, or <= 1 second)
            if (!Number.isFinite(val) || val === Infinity || val <= 1) {
              if (this.__bridgeDurationHintSec && Number.isFinite(this.__bridgeDurationHintSec) && this.__bridgeDurationHintSec > 0) {
                return this.__bridgeDurationHintSec;
              }
              if (window.__bridgeGlobalDurationHint && Number.isFinite(window.__bridgeGlobalDurationHint) && window.__bridgeGlobalDurationHint > 0) {
                return window.__bridgeGlobalDurationHint;
              }
              return 14400; // Default fallback (4 hours)
            }
            return val;
          },
          configurable: true,
          enumerable: origDesc.enumerable,
        });
      }
    } catch (_err) { }
  }

  // ==========================================================================
  // 2. Previous State Cleanup & Global State Initialization
  // ==========================================================================
  // Cleans up old control panel, listeners, and Hls.js instance
  // to prevent memory leaks when re-injecting the script.
  const existingPanel = document.getElementById(PANEL_ID);
  const previousState = window[STATE_KEY];

  if (previousState && typeof previousState.cleanup === "function") {
    try { previousState.cleanup(); } catch (_err) { }
  }
  if (previousState && previousState.hls) {
    try { previousState.hls.destroy(); } catch (_err) { }
  }
  if (existingPanel) {
    existingPanel.remove();
    console.log(`[M-Stream Bridge v${VERSION}]`);
  }

  window[STATE_KEY] = { ...(previousState || {}), hls: null, cleanup: null };
  const sharedState = window[STATE_KEY];

  if (!Number.isFinite(Number(sharedState.lastPlaybackTimeSec))) sharedState.lastPlaybackTimeSec = 0;
  if (typeof sharedState.lastPlaybackKey !== "string") sharedState.lastPlaybackKey = "";
  if (typeof sharedState.lastPlaybackTitle !== "string") sharedState.lastPlaybackTitle = "";
  if (!Number.isFinite(Number(sharedState.lastPlaybackUpdatedAt))) sharedState.lastPlaybackUpdatedAt = 0;
  if (!Number.isFinite(Number(sharedState.lastDurationHintSec))) sharedState.lastDurationHintSec = 0;
  if (typeof sharedState.lastDurationHintKey !== "string") sharedState.lastDurationHintKey = "";
  if (typeof sharedState.activeVideoStreamKey !== "string") sharedState.activeVideoStreamKey = "";

  // ==========================================================================
  // 3. Style Injection (CSS)
  // ==========================================================================
  const style = document.createElement("style");
  style.textContent = `
    :root {
      --bridge-sans: "Segoe UI", Arial, sans-serif;
      --bridge-mono: "Cascadia Mono", Consolas, monospace;
    }
    #${PANEL_ID} {
      --bg: #f5f3fa;
      --log-bg: #eae6f8;
      --border: rgba(75, 0, 178, 0.08);
      --text-main: #26124c;
      --text-second: #5d4c82;
      --text-muted: #8e81ac;
      --primary: #4B00B2;
      --primary-hover: #6D28D9;
      --shadow-dark: #cbd0ec;
      --shadow-light: #ffffff;
      --bridge-sans: "Segoe UI", Arial, sans-serif;
      --bridge-mono: "Cascadia Mono", Consolas, monospace;

      position: fixed;
      right: 18px;
      bottom: 18px;
      width: 268px;
      z-index: 2147483647;
      border-radius: 12px;
      background: var(--bg);
      color: var(--text-main);
      border: 1px solid var(--border);
      box-shadow: 0 12px 32px rgba(75, 0, 178, 0.16);
      font-family: var(--bridge-sans);
      overflow: hidden;
      transition: opacity 0.3s ease, box-shadow 0.2s ease;
    }
    #${PANEL_ID}.dragging {
      user-select: none !important;
      transition: none !important;
      box-shadow: 0 18px 42px rgba(75, 0, 178, 0.28) !important;
    }
    #${PANEL_ID} * { box-sizing: border-box; margin: 0; padding: 0; }
    #${PANEL_ID} .titlebar {
      display: flex;
      align-items: center;
      padding: 10px 12px;
      background: var(--log-bg);
      border-bottom: 1px solid var(--border);
      cursor: grab;
      user-select: none;
      position: relative;
    }
    #${PANEL_ID}.dragging .titlebar {
      cursor: grabbing !important;
    }
    #${PANEL_ID} .tb-left {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      z-index: 1;
    }
    #${PANEL_ID} .tb-right {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      z-index: 1;
    }
    #${PANEL_ID} .tb-center {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      max-width: calc(100% - 130px);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${PANEL_ID} .tb-brand {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1px;
      line-height: 1;
      min-width: 0;
    }
    #${PANEL_ID} .tb-name {
      font-family: 'Outfit', var(--bridge-sans);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: var(--primary);
    }
    #${PANEL_ID} .tb-watermark {
      font-size: 9px;
      font-weight: 500;
      font-family: var(--bridge-mono);
      color: var(--text-muted);
    }
    #${PANEL_ID} .tb-ver {
      font-size: 9.5px;
      color: var(--text-muted);
      font-family: var(--bridge-mono);
      font-weight: 600;
    }
    #${PANEL_ID} .tb-chev {
      font-size: 10px;
      color: var(--text-muted);
      transition: transform .2s;
      z-index: 1;
    }
    #${PANEL_ID}.collapsed .tb-chev { transform: rotate(180deg); }
    #${PANEL_ID}.collapsed .body { display: none; }
    #${PANEL_ID} .body { padding: 12px; }

    #${PANEL_ID} .stream-box {
      background: transparent;
      border: none;
      border-radius: 0;
      padding: 0;
      margin-bottom: 12px;
      box-shadow: none;
    }
    #${PANEL_ID} .sb-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 700;
      font-family: var(--bridge-mono);
      padding: 3px 8px;
      border-radius: 20px;
      line-height: 1.2;
      color: var(--text-second);
      background: var(--bg);
      box-shadow: inset 1.5px 1.5px 3px var(--shadow-dark), inset -1.5px -1.5px 3px var(--shadow-light);
    }
    #${PANEL_ID} .sb-meta {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }
    #${PANEL_ID} .pill-hls {
      background: rgba(75, 0, 178, 0.12);
      color: var(--primary);
    }
    #${PANEL_ID} .pill-direct {
      background: rgba(15, 118, 110, 0.12);
      color: #0F766E;
    }
    #${PANEL_ID} .pill-season { color: var(--text-second); }
    #${PANEL_ID} .pill-episode { color: var(--text-second); }

    #${PANEL_ID} .sb-label {
      font-size: 9.5px;
      color: var(--text-muted);
      margin-bottom: 4px;
      font-family: var(--bridge-mono);
      font-weight: 600;
      text-transform: lowercase;
    }
    #${PANEL_ID} .sb-title {
      font-family: 'Outfit', var(--bridge-sans);
      font-size: 13px;
      font-weight: 700;
      color: var(--text-main);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${PANEL_ID} .sb-url {
      font-family: var(--bridge-mono);
      font-size: 9.5px;
      color: var(--text-second);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      background: var(--bg);
      box-shadow: inset 1.5px 1.5px 3px var(--shadow-dark), inset -1.5px -1.5px 3px var(--shadow-light);
      padding: 4px 6px;
      border-radius: 6px;
      margin-top: 6px;
    }

    #${PANEL_ID} .row { display: flex; gap: 6px; margin-bottom: 6px; }
    #${PANEL_ID} button {
      flex: 1;
      border: none;
      border-radius: 20px;
      padding: 7px 10px;
      font-size: 11.5px;
      font-weight: 700;
      font-family: 'Outfit', var(--bridge-sans);
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
    }
    #${PANEL_ID} button:hover {
      opacity: 0.9;
      transform: translateY(-0.5px);
    }
    #${PANEL_ID} button:active {
      transform: translateY(0);
    }
    #${PANEL_ID} button.good {
      background: var(--primary);
      color: #ffffff;
      box-shadow: 2px 2px 6px var(--shadow-dark), -2px -2px 6px var(--shadow-light);
    }
    #${PANEL_ID} button.good:hover {
      background: var(--primary-hover);
      box-shadow: 3px 3px 8px var(--shadow-dark), -3px -3px 8px var(--shadow-light);
    }
    #${PANEL_ID} button.good:active {
      box-shadow: inset 1.5px 1.5px 3px rgba(0, 0, 0, 0.2);
    }
    #${PANEL_ID} button.secondary {
      background: var(--bg);
      color: var(--text-second);
      border: 1px solid var(--border);
      box-shadow: 2px 2px 6px var(--shadow-dark), -2px -2px 6px var(--shadow-light);
    }
    #${PANEL_ID} button.secondary:hover {
      color: var(--text-main);
      box-shadow: 3px 3px 8px var(--shadow-dark), -3px -3px 8px var(--shadow-light);
    }
    #${PANEL_ID} button.secondary:active {
      box-shadow: inset 1.5px 1.5px 3px var(--shadow-dark), inset -1.5px -1.5px 3px var(--shadow-light);
    }

    #${PANEL_ID} .status {
      font-size: 10px;
      font-family: var(--bridge-mono);
      color: var(--text-second);
      padding-top: 8px;
      border-top: 1px solid var(--border);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 4px;
    }

    .mode-view { display: none; }
    .mode-view.active { display: block; }

    .gs-progress-container {
      background: var(--bg); border-radius: 8px; height: 16px; margin: 10px 0; overflow: hidden;
      border: 1px solid var(--border); position: relative;
      box-shadow: inset 1.5px 1.5px 3px var(--shadow-dark), inset -1.5px -1.5px 3px var(--shadow-light);
    }
    .gs-progress-bar {
      height: 100%; background: var(--primary); width: 0%; transition: width 0.3s;
    }
    .gs-progress-text {
      text-align: right; font-size: 11px; font-weight: bold;
      color: var(--primary); margin-bottom: 2px;
    }

    #${PANEL_ID} #bridge-back-btn {
      background: transparent; border: none; padding: 0; cursor: pointer; color: var(--primary);
      display: none; box-shadow: none; width: 28px; height: 28px;
      position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
      border-radius: 6px; z-index: 10; align-items: center; justify-content: center;
      font-family: Arial, sans-serif; font-size: 16px; font-weight: bold; line-height: 1;
    }
    #${PANEL_ID} #bridge-back-btn.active { display: flex; }
    #${PANEL_ID} #bridge-back-btn:hover { background: rgba(75, 0, 178, 0.1); transform: translateY(-50%); }
    #${PANEL_ID} #bridge-back-btn:active { transform: translateY(-50%) scale(0.9); }
  `;
  document.documentElement.appendChild(style);

  // ==========================================================================
  // 4. Render Console Panel (HTML DOM)
  // ==========================================================================
  const panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="titlebar" data-action="toggle-collapse">
      <button data-action="back-to-select" id="bridge-back-btn">&#10094;</button>
      <div class="tb-center">
        <div class="tb-brand">
          <span class="tb-name">M-Stream Bridge</span>
          <span class="tb-watermark">by Zielzy</span>
        </div>
      </div>
      <div class="tb-right">
        <span class="tb-ver">v${VERSION}</span>
        <span class="tb-chev">&#9650;</span>
      </div>
    </div>
    <div class="body">
      <!-- MODE SELECTOR VIEW -->
      <div id="view-mode-select" class="mode-view active">
        <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 0;">
          <button class="secondary" data-action="mode-standard">
            <span>Standard Mode</span>
          </button>
          <button class="secondary" data-action="mode-full">
            <span>Full Mode</span>
          </button>
        </div>
      </div>

      <!-- FULL MODE LOADING VIEW -->
      <div id="view-full-loading" class="mode-view">
        <div style="display: flex; justify-content: space-between; align-items: flex-end; border-top: 1px solid var(--border); padding-top: 8px; margin-top: 4px;">
          <div class="status" id="bridge-fullmode-status" style="border: none; padding: 0; margin: 0;">Extracting audio...</div>
          <div class="gs-progress-text" id="bridge-fullmode-text">0%</div>
        </div>
        <div class="gs-progress-container">
          <div class="gs-progress-bar" id="bridge-fullmode-bar"></div>
        </div>
        <div style="font-size: 11px; color: #888; margin-bottom: 12px; line-height: 1.4;">
          Please wait, extracting audio from the stream for Full Mode.
        </div>
        <div class="row">
          <button class="secondary" data-action="cancel-fullmode"><span>Cancel</span></button>
        </div>
      </div>

      <!-- STANDARD WATCH VIEW -->
      <div id="view-standard-mode" class="mode-view">
        <div class="stream-box">
          <div class="sb-meta">
            <div class="sb-pill pill-hls" id="bridge-pill" style="display: none;">HLS</div>
            <div class="sb-pill pill-season" id="bridge-season" style="display: none;">S01</div>
            <div class="sb-pill pill-episode" id="bridge-episode" style="display: none;">EP01</div>
          </div>
          <div class="sb-label">stream detected</div>
          <div class="sb-title" id="bridge-title">No stream yet</div>
          <div class="sb-url" id="bridge-url">-</div>
        </div>

        <div class="row">
          <button class="secondary" data-action="play-proxy"><span>Proxy</span></button>
          <button class="secondary" data-action="play-direct"><span>Direct</span></button>
        </div>
        <div class="row" style="margin-bottom: 8px;">
          <button class="good" data-action="subtitle-inject-once" id="bridge-subtitle-inject"><span>Subtitle</span></button>
        </div>
        <div class="status" id="bridge-status">Ready</div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  // Bind DOM elements to variables for UI state manipulation
  const statusEl = panel.querySelector("#bridge-status");
  const titleEl = panel.querySelector("#bridge-title");
  const urlEl = panel.querySelector("#bridge-url");
  const pillEl = panel.querySelector("#bridge-pill");
  const seasonEl = panel.querySelector("#bridge-season");
  const episodeEl = panel.querySelector("#bridge-episode");
  const subtitleInjectBtn = panel.querySelector("#bridge-subtitle-inject");

  const viewModeSelect = panel.querySelector("#view-mode-select");
  const viewStandardMode = panel.querySelector("#view-standard-mode");
  const viewFullLoading = panel.querySelector("#view-full-loading");
  const backBtn = panel.querySelector("#bridge-back-btn");
  const fullModeStatus = panel.querySelector("#bridge-fullmode-status");
  const fullModeBar = panel.querySelector("#bridge-fullmode-bar");
  const fullModeText = panel.querySelector("#bridge-fullmode-text");

  let fullModePollInterval = null;

  function switchView(viewId) {
    viewModeSelect.classList.remove("active");
    viewStandardMode.classList.remove("active");
    viewFullLoading.classList.remove("active");
    if (viewId === "select") {
      viewModeSelect.classList.add("active");
      if (backBtn) backBtn.classList.remove("active");
    } else {
      if (backBtn) backBtn.classList.add("active");
    }

    if (viewId === "standard") viewStandardMode.classList.add("active");
    else if (viewId === "fullmode") viewFullLoading.classList.add("active");
  }

  let latestStream = null;
  let latestStreamKey = "";
  let subtitleLastInjectedKey = "";
  let isInjectingSubtitle = false;

  let autoSyncTimer = null;
  let autoSyncInFlight = false;
  let lastUserPlayAction = 0;

  /**
   * Sets the status text and text color on the bottom control panel.
   * @param {string} message - Message text.
   * @param {boolean} isError - True if error format.
   */
  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.style.color = isError ? "#ef4444" : "var(--primary)";
  }

  // ==========================================================================
  // 5. Update Checker
  // ==========================================================================
  function isNewerVersion(candidate, current) {
    const parseVersion = (value) => {
      const [core, prerelease = ""] = String(value || "").trim().replace(/^v/i, "").split("-", 2);
      const parts = core.split(".").slice(0, 3).map((token) => Number.parseInt(token, 10) || 0);
      while (parts.length < 3) parts.push(0);
      return { parts, prerelease };
    };
    const next = parseVersion(candidate);
    const active = parseVersion(current);
    for (let i = 0; i < 3; i++) {
      if (next.parts[i] !== active.parts[i]) return next.parts[i] > active.parts[i];
    }
    return Boolean(active.prerelease && !next.prerelease);
  }

  (async function checkUpdate() {
    try {
      const resp = await fetch("https://raw.githubusercontent.com/Zielzy/M-Stream-Bridge/main/index.min.json", { cache: "no-store" });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && data.version && isNewerVersion(data.version, VERSION)) {
        statusEl.style.color = "#d9534f";
        statusEl.style.fontWeight = "bold";
        statusEl.innerHTML = `Update v${data.version} available! <a href="${data.download_url || "https://github.com/Zielzy/M-Stream-Bridge/releases/latest"}" target="_blank" style="color: var(--primary); text-decoration: underline; font-weight: bold; margin-left: 5px;">Get it</a>`;
      }
    } catch (_e) { }
  })();

  // ==========================================================================
  // 6. UI Render Helpers
  // ==========================================================================

  /**
   * Populates active stream info into UI elements (Title, Season, Episode, Stream Type).
   * @param {Object} info - Stream metadata payload.
   */
  function setStreamPreview(info) {
    const url = (info && (info.stream_url || info.m3u8_url)) || "";
    const title = (info && (info.clean_title || info.display_title || info.title)) || "Bridge Stream";
    const streamType = (info && info.stream_type) || "";
    const season = Number(info && info.season);
    const episode = Number(info && info.episode);

    titleEl.textContent = title;
    urlEl.textContent = url || "-";

    if (url) {
      pillEl.style.display = "inline-flex";
      if (streamType === "direct" || /\.mp4(\?|$)/i.test(url)) {
        pillEl.textContent = "DIRECT";
        pillEl.className = "sb-pill pill-direct";
      } else {
        pillEl.textContent = "HLS";
        pillEl.className = "sb-pill pill-hls";
      }
    } else {
      pillEl.style.display = "none";
    }

    if (Number.isFinite(season) && season > 0) {
      seasonEl.textContent = `S${String(Math.trunc(season)).padStart(2, "0")}`;
      seasonEl.style.display = "inline-flex";
    } else {
      seasonEl.textContent = "S--";
      seasonEl.style.display = "none";
    }

    if (Number.isFinite(episode) && episode > 0) {
      episodeEl.textContent = `EP${String(Math.trunc(episode)).padStart(2, "0")}`;
      episodeEl.style.display = "inline-flex";
    } else {
      episodeEl.textContent = "EP--";
      episodeEl.style.display = "none";
    }
  }

  /**
   * Clears stream info from the control panel when no stream is stored.
   */
  function clearStreamPreview() {
    titleEl.textContent = "No stream yet";
    urlEl.textContent = "-";
    pillEl.style.display = "none";
    seasonEl.style.display = "none";
    episodeEl.style.display = "none";
  }

  /**
   * Generates a unique stream key for active stream identification.
   * @param {Object} info - Stream metadata payload.
   * @returns {string} Unique composite stream key.
   */
  function getStreamKey(info) {
    if (!info) return "";
    const ep = info.episode || info.detected_episode || "";
    const season = info.season || "";
    return [info.stream_url || "", info.stream_type || "", info.title || "", season, ep].join("|");
  }

  /**
   * Normalizes title characters for comparison (lower-case, single space, alphanumeric only).
   * @param {string} text - Raw title string.
   * @returns {string} Clean normalized string.
   */
  function normalizeTitleToken(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[|_]+/g, " ")
      .replace(/[^\p{L}\p{N}\s-]+/gu, "")
      .trim();
  }

  /**
   * Formats seconds into a human-readable clock format (HH:MM:SS or MM:SS).
   * @param {number} totalSec - Total seconds.
   * @returns {string} Formatted time string.
   */
  function formatClock(totalSec) {
    const sec = Math.max(0, Math.trunc(Number(totalSec) || 0));
    const h = Math.trunc(sec / 3600);
    const m = Math.trunc((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // ==========================================================================
  // 7. Playback Resume & Tracking
  // ==========================================================================

  /**
   * Saves the last playback position (currentTime) to persistent state.
   * @param {HTMLMediaElement} video - Target video element.
   * @param {string} streamKey - Active stream composite key.
   * @param {string} streamTitle - Active stream title.
   */
  function savePlaybackSnapshot(video, streamKey, streamTitle) {
    if (!video || !Number.isFinite(Number(video.currentTime))) return;
    const t = Number(video.currentTime);
    if (!(t > 0.4)) return;
    sharedState.lastPlaybackTimeSec = t;
    if (streamKey) sharedState.lastPlaybackKey = String(streamKey);
    if (streamTitle) sharedState.lastPlaybackTitle = String(streamTitle);
    sharedState.lastPlaybackUpdatedAt = Date.now();
  }

  /**
   * Binds playback progress tracking events to the video element
   * to keep state synchronized across navigation.
   * @param {HTMLMediaElement} video - Target video element.
   * @param {string} streamKey - Active stream composite key.
   * @param {string} streamTitle - Active stream title.
   */
  function bindPlaybackTracker(video, streamKey, streamTitle) {
    if (!video) return;
    if (typeof video.__bridgePlaybackCleanup === "function") {
      try { video.__bridgePlaybackCleanup(); } catch (_err) { }
    }

    const capture = function () {
      savePlaybackSnapshot(video, streamKey, streamTitle);
    };

    const onTimeupdate = function () { capture(); updateDurationState(); };
    const onSeeked = function () { capture(); updateDurationState(); };
    const onPause = function () { capture(); };
    const onEnded = function () { capture(); };
    const onLoadedMetadata = function () {
      applyDurationHint(video, video.duration, streamKey, true);
      updateDurationState();
    };
    const onDurationChange = function () {
      applyDurationHint(video, video.duration, streamKey, true);
      updateDurationState();
    };

    video.addEventListener("timeupdate", onTimeupdate);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("durationchange", onDurationChange);

    video.__bridgePlaybackCleanup = function () {
      video.removeEventListener("timeupdate", onTimeupdate);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("durationchange", onDurationChange);
    };
  }

  /**
   * Retrieves previous playback position if title or stream key matches.
   * Saved state age is limited to 6 hours max.
   * @param {Object} info - Stream metadata.
   * @param {string} streamKey - Stream composite key.
   * @returns {number} Saved timestamp in seconds.
   */
  function getRestoreTime(info, streamKey) {
    const saved = Number(sharedState.lastPlaybackTimeSec || 0);
    if (!(saved > 1)) return 0;
    const savedKey = String(sharedState.lastPlaybackKey || "");
    const currentTitle = normalizeTitleToken(info && info.title);
    const savedTitle = normalizeTitleToken(sharedState.lastPlaybackTitle || "");

    const keyMatch = !savedKey || !streamKey || savedKey === streamKey;
    const titleMatch = currentTitle && savedTitle && currentTitle === savedTitle;
    if (!keyMatch && !titleMatch) return 0;

    const currentEp = Number(info && (info.episode || info.detected_episode)) || 0;
    const savedEp = (() => {
      const parts = savedKey.split("|");
      return Number(parts[parts.length - 1]) || 0;
    })();
    if (currentEp && savedEp && currentEp !== savedEp) return 0;

    const ageMs = Date.now() - Number(sharedState.lastPlaybackUpdatedAt || 0);
    if (ageMs > 6 * 60 * 60 * 1000) return 0;
    return saved;
  }

  /**
   * Restores video playback position to the last saved timestamp.
   * @param {HTMLMediaElement} video - Target video element.
   * @param {number} restoreSec - Timestamp in seconds to seek to.
   */
  function applyPlaybackRestore(video, restoreSec) {
    if (!video || !(restoreSec > 1)) return;
    let applied = false;
    const doRestore = function (e) {
      if (applied) return;

      const isHttp = video.currentSrc && video.currentSrc.startsWith("http");
      const isOurHls = sharedState.hls && video.currentSrc === video.src && video.currentSrc.startsWith("blob:");

      if (!isHttp && !isOurHls) {
        if (e && e.type) {
          video.addEventListener(e.type, doRestore, { once: true });
        } else {
          setTimeout(doRestore, 1000);
        }
        return;
      }

      const duration = Number(video.duration);
      let target = restoreSec;
      if (Number.isFinite(duration) && duration > 0) {
        target = Math.min(target, Math.max(0, duration - 1));
      }
      if (!(target > 0.4)) return;
      try {
        video.currentTime = target;
        applied = true;
        setStatus(`Playback restored to ${formatClock(target)}.`, false);
      } catch (_err) { }
    };

    video.addEventListener("loadedmetadata", doRestore, { once: true });
    video.addEventListener("canplay", doRestore, { once: true });
    setTimeout(doRestore, 1000);
  }

  // ==========================================================================
  // 8. Data Sync & API Calls
  // ==========================================================================

  /**
   * Normalizes API response data structure for consistent consumption by the player UI.
   * @param {Object} raw - Raw API response json.
   * @returns {Object} Clean stream object.
   */
  function normalizeApiData(raw) {
    const nested = raw && raw.stream ? raw.stream : {};
    const streamUrl = (nested.stream_url || nested.m3u8_url || raw.stream_url || raw.m3u8_url || "").trim();
    const streamType = (nested.stream_type || raw.stream_type || "").trim().toLowerCase();
    const title = (nested.clean_title || nested.display_title || nested.title || raw.clean_title || raw.display_title || raw.title || "Bridge Stream").trim() || "Bridge Stream";
    const subtitle = (nested.subtitle_url || raw.subtitle_url || "").trim();
    const contentType = (nested.content_type || raw.content_type || "").trim();
    const hasStream = Boolean(raw.has_stream || streamUrl);
    const playbackUrl = (raw.playback_url || "").trim();
    let season = nested.season ?? raw.season ?? null;
    let episode = nested.episode ?? raw.episode ?? nested.detected_episode ?? raw.detected_episode ?? null;

    if (typeof season === "string" && /^\d+$/.test(season)) season = parseInt(season, 10);
    if (typeof episode === "string" && /^\d+$/.test(episode)) episode = parseInt(episode, 10);
    if (!Number.isFinite(season) || season <= 0) season = null;
    if (!Number.isFinite(episode) || episode <= 0) episode = null;

    return {
      hasStream,
      stream_url: streamUrl,
      stream_type: streamType || (/\.m3u8(\?|$)/i.test(streamUrl) ? "hls" : "direct"),
      m3u8_url: streamUrl,
      title,
      clean_title: title,
      season,
      episode,
      subtitle_url: subtitle,
      content_type: contentType,
      proxy_url: playbackUrl || `${BRIDGE_ORIGIN}/stream.m3u8`,
      proxy_subtitle_url: `${BRIDGE_ORIGIN}/proxy-subtitle`,
    };
  }

  /**
   * Fetches active stream status from local server.
   * @returns {Promise<Object>} Normalized stream state.
   */
  async function fetchCurrentStreamState() {
    const resp = await fetch(`${BRIDGE_ORIGIN}/api/current-stream`, { cache: "no-store" });
    if (!resp.ok) {
      throw new Error(`Bridge API failed (${resp.status}).`);
    }
    const data = await resp.json();
    return normalizeApiData(data || {});
  }

  /**
   * Helper to fetch current stream state, throwing an error if empty.
   * @returns {Promise<Object>} Normalized stream state.
   */
  async function fetchCurrentStream() {
    const normalized = await fetchCurrentStreamState();
    if (!normalized.hasStream || !normalized.stream_url) {
      throw new Error("Bridge has no active stream yet.");
    }
    return normalized;
  }

  /**
   * Checks if stream URL is HLS (.m3u8).
   * @param {Object} info - Stream metadata.
   * @returns {boolean} True if HLS stream.
   */
  function isHlsStream(info) {
    const url = info.stream_url || info.m3u8_url || "";
    if ((info.stream_type || "").toLowerCase() === "hls") return true;
    if ((info.stream_type || "").toLowerCase() === "direct") return false;
    return /mpegurl/i.test(info.content_type || "") || /\.m3u8(\?|$)/i.test(url) || /master|playlist|manifest/i.test(url);
  }

  // ==========================================================================
  // 9. Stream Duration Parsing & Remote API
  // ==========================================================================

  function finiteDuration(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 1 ? n : 0;
  }

  /**
   * Calls local server API to parse remote HLS manifest and retrieve true duration.
   * @param {string} streamUrl - Target stream URL.
   * @returns {Promise<number>} Duration in seconds.
   */
  async function fetchHlsDurationHint(streamUrl) {
    try {
      if (!streamUrl) return 0;
      console.log(`[Bridge] Requesting duration from /api/stream-duration?url=${streamUrl.slice(0, 50)}...`);
      const resp = await fetch(`${BRIDGE_ORIGIN}/api/stream-duration?url=${encodeURIComponent(streamUrl)}`, { cache: "no-store" });
      if (resp.ok) {
        const data = await resp.json();
        console.log("[Bridge] Duration API response:", data);
        if (data && data.duration_sec) {
          return finiteDuration(data.duration_sec) || 0;
        }
      } else {
        console.warn("[Bridge] Duration API failed:", resp.status);
      }
    } catch (err) {
      console.error("[Bridge] Duration API error:", err);
    }
    return 0;
  }

  /**
   * Stores video duration hint in global memory state.
   * @param {number} durationSec - Duration in seconds.
   * @param {string} streamKey - Stream composite key.
   * @returns {number} Recorded duration in seconds.
   */
  function rememberDurationHint(durationSec, streamKey) {
    const duration = finiteDuration(durationSec);
    const cached = getCachedDurationHint(streamKey);
    if (cached > 0 && (!duration || (duration < cached && sharedState.lastDurationHintKey === String(streamKey)))) {
      return cached;
    }
    if (!duration) return 0;
    sharedState.lastDurationHintSec = duration;
    if (streamKey) sharedState.lastDurationHintKey = String(streamKey);
    return duration;
  }

  /**
   * Retrieves cached duration hint if stream key matches.
   * @param {string} streamKey - Stream composite key.
   * @returns {number} Cached duration in seconds.
   */
  function getCachedDurationHint(streamKey) {
    if (!streamKey || sharedState.lastDurationHintKey !== String(streamKey)) return 0;
    return finiteDuration(sharedState.lastDurationHintSec);
  }

  /**
   * Resets video duration override data.
   * @param {string} streamKey - Stream composite key.
   */
  function resetDurationHint(streamKey) {
    sharedState.lastDurationHintSec = 0;
    sharedState.lastDurationHintKey = streamKey ? String(streamKey) : "";
    try { delete window.__bridgeGlobalDurationHint; } catch (_err) { }
    if (sharedState.activeVideo) {
      try { delete sharedState.activeVideo.__bridgeDurationHintSec; } catch (_err) { }
      try { sharedState.activeVideo.dispatchEvent(new Event("durationchange")); } catch (_err) { }
    }
    updateDurationState();
  }

  /**
   * Applies video duration hint to active video element and dispatches 'durationchange'.
   * @param {HTMLMediaElement} video - Target video element.
   * @param {number} durationSec - Duration in seconds.
   * @param {string} streamKey - Stream composite key.
   * @param {boolean} skipDispatch - True to skip event dispatch.
   * @returns {boolean} True if duration was set.
   */
  function applyDurationHint(video, durationSec, streamKey, skipDispatch = false) {
    const duration = rememberDurationHint(durationSec, streamKey);
    if (!duration) return false;
    if (window.__bridgeGlobalDurationHint !== duration) {
      window.__bridgeGlobalDurationHint = duration;
      console.log("[Bridge] Global duration hint set to:", duration);
    }
    if (!video) {
      updateDurationState();
      return true;
    }
    const changed = video.__bridgeDurationHintSec !== duration;
    video.__bridgeDurationHintSec = duration;
    updateDurationState();
    if (changed && !skipDispatch) {
      try { video.dispatchEvent(new Event("durationchange")); } catch (_e) { }
    }
    return true;
  }

  /**
   * Fetches true duration from local server and applies as override.
   * @param {HTMLMediaElement} video - Target video element.
   * @param {Object} info - Stream metadata.
   * @param {string} sourceUrl - Active stream URL.
   * @param {boolean} hls - True if HLS stream.
   * @returns {Promise<number>} Applied duration.
   */
  async function loadDurationHint(video, info, sourceUrl, hls) {
    const streamKey = getStreamKey(info);
    sharedState.durationHintRequestKey = streamKey;

    const explicit = rememberDurationHint(info && (info.duration || info.duration_sec || info.duration_seconds), streamKey);
    if (explicit) {
      applyDurationHint(video, explicit, streamKey);
      return explicit;
    }
    const cached = getCachedDurationHint(streamKey);
    if (cached) {
      applyDurationHint(video, cached, streamKey);
      return cached;
    }
    if (!hls) {
      updateDurationState();
      return 0;
    }
    try {
      const fetchedDuration = await fetchHlsDurationHint(info.stream_url || info.m3u8_url);
      console.log("[Bridge] Fetched duration:", fetchedDuration);
      if (sharedState.durationHintRequestKey !== streamKey) {
        console.log("[Bridge] Stream key mismatch! Aborting hint application.");
        return 0;
      }
      const duration = rememberDurationHint(fetchedDuration, streamKey);
      if (duration) applyDurationHint(video, duration, streamKey);
      else updateDurationState();
      return duration;
    } catch (_err) {
      return 0;
    }
  }

  // ==========================================================================
  // 10. DOM Video Scanning
  // ==========================================================================

  function getActiveBridgeVideo() {
    const active = sharedState.activeVideo;
    if (
      active
      && active.isConnected
      && (
        !sharedState.activeVideoStreamKey
        || !latestStreamKey
        || sharedState.activeVideoStreamKey === latestStreamKey
      )
    ) {
      return active;
    }
    const video = findVideoElementDeep();
    if (video && (!sharedState.activeVideoStreamKey || !latestStreamKey || sharedState.activeVideoStreamKey === latestStreamKey)) {
      sharedState.activeVideo = video;
      return video;
    }
    return null;
  }

  /**
   * Stores native video duration in state for persistence.
   * Called during video progress or navigation.
   */
  function updateDurationState() {
    const video = getActiveBridgeVideo();
    const nativeDuration = finiteDuration(video && video.duration);
    const hintKey = sharedState.activeVideoStreamKey || latestStreamKey || sharedState.lastDurationHintKey;
    if (nativeDuration) rememberDurationHint(nativeDuration, hintKey);
  }

  function destroyHls() {
    if (sharedState.hls) {
      try {
        sharedState.hls.destroy();
      } catch (_err) { }
      sharedState.hls = null;
    }
  }

  /**
   * Performs a deep DOM scan through Shadow Roots and nested iframes
   * to locate HTML5 <video> elements.
   * @returns {HTMLVideoElement|null} Found video element.
   */
  function findVideoElementDeep() {
    const queue = [document];
    const visited = new Set();

    while (queue.length) {
      const root = queue.shift();
      if (!root || visited.has(root)) continue;
      visited.add(root);

      try {
        if (root.querySelector) {
          const video = root.querySelector("video");
          if (video) return video;
        }
      } catch (_err) { }

      let allNodes = [];
      try {
        if (root.querySelectorAll) {
          allNodes = Array.from(root.querySelectorAll("*"));
        }
      } catch (_err) { }

      for (const node of allNodes) {
        if (node && node.shadowRoot) {
          queue.push(node.shadowRoot);
        }
        if (node && node.tagName === "IFRAME") {
          try {
            if (node.contentDocument) queue.push(node.contentDocument);
          } catch (_err) { }
        }
      }
    }
    return null;
  }

  /**
   * Polls periodically until video element is loaded in DOM.
   * @param {number} timeoutMs - Timeout in milliseconds.
   * @returns {Promise<HTMLVideoElement>} Found video element.
   */
  async function ensureVideoElement(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const video = findVideoElementDeep();
      if (video) {
        return video;
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Migaku <video> element was not found.");
  }

  /**
   * Attaches local/external subtitle <track> element to video object.
   * @param {HTMLMediaElement} video - Target video element.
   * @param {Object} info - Stream metadata payload.
   * @param {boolean} useProxy - True if proxy subtitle url should be used.
   */
  function attachSubtitle(video, info, useProxy) {
    if (!info.subtitle_url) return;
    const trackSrc = useProxy ? info.proxy_subtitle_url : info.subtitle_url;

    video.querySelectorAll("track[data-bridge-track='1']").forEach((t) => t.remove());
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = "Bridge Subtitle";

    track.default = true;
    track.src = trackSrc;
    track.setAttribute("data-bridge-track", "1");
    video.appendChild(track);
  }

  // ==========================================================================
  // 11. Bootstrap By In-Memory Dummy Video Drop
  // ==========================================================================
  // Used when opening a blank local Migaku player page.
  // Dynamically generates a 1-second dummy WebM video in memory,
  // then dispatches drag-and-drop events to Migaku automatically.
  // This forces Migaku to activate its native video player.

  function findLocalVideoInput() {
    const inputs = Array.from(document.querySelectorAll("input[type='file']"));
    for (const input of inputs) {
      const accept = String(input.getAttribute("accept") || "").toLowerCase();
      if (!accept || accept.includes("video")) return input;
    }
    return inputs[0] || null;
  }

  function findDropZone() {
    const candidates = Array.from(document.querySelectorAll("div, section, main"));
    for (const el of candidates) {
      const text = String(el.textContent || "").toLowerCase();
      if (text.includes("drop") || text.includes("file") || text.includes("video")) return el;
    }
    return document.body;
  }

  /**
   * Generates a short (1-second) dummy WebM video in memory using HTML5 Canvas.
   * @returns {Promise<File>} Generated WebM video file.
   */
  function generateDummyVideoFile() {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext("2d");
      if (!ctx || !canvas.captureStream || !window.MediaRecorder) {
        reject(new Error("Browser does not support dummy-video bootstrap."));
        return;
      }

      let frame = 0;
      const fps = 24;
      const draw = () => {
        frame += 1;
        ctx.fillStyle = "#050505";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 22px Segoe UI";
        const titleText = (latestStream && latestStream.title) ? latestStream.title : "bridge-bootstrap";
        ctx.fillText(titleText.substring(0, 25), 18, 86);
        ctx.fillStyle = "#22d3ee";
        const x = 20 + ((frame * 4) % 260);
        ctx.fillRect(x, 110, 40, 10);
      };
      draw();
      const drawTimer = setInterval(draw, Math.floor(1000 / fps));

      const stream = canvas.captureStream(fps);
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      let audioCtx = null;
      let osc = null;
      let audioTrack = null;

      if (AudioCtx) {
        try {
          audioCtx = new AudioCtx();
          if (audioCtx.state === "suspended") {
            audioCtx.resume().catch(function () { });
          }
          const gainNode = audioCtx.createGain();
          const audioDest = audioCtx.createMediaStreamDestination();
          osc = audioCtx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = 220;
          gainNode.gain.value = DUMMY_AUDIO_GAIN;
          osc.connect(gainNode);
          gainNode.connect(audioDest);
          osc.start();
          audioTrack = audioDest.stream.getAudioTracks()[0] || null;
        } catch (_err) {
          audioCtx = null;
          osc = null;
          audioTrack = null;
        }
      }

      const mixedTracks = stream.getVideoTracks().slice();
      if (audioTrack) mixedTracks.push(audioTrack);
      const mixedStream = new MediaStream(mixedTracks);

      let mime = "video/webm;codecs=vp8";
      if (!MediaRecorder.isTypeSupported(mime)) {
        mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
      }

      const chunks = [];
      const rec = new MediaRecorder(mixedStream, { mimeType: mime });
      rec.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      rec.onerror = () => reject(new Error("Failed to create dummy video recorder."));
      rec.onstop = () => {
        try {
          clearInterval(drawTimer);
          const blob = new Blob(chunks, { type: "video/webm" });
          const fileName = (latestStream && latestStream.title)
            ? `${latestStream.title.replace(/[^a-zA-Z0-9_\-]/g, "_").replace(/_+/g, "_")}_Init.webm`
            : "M_Stream_Init.webm";
          const file = new File([blob], fileName, { type: "video/webm" });
          if (osc) {
            try {
              osc.stop();
            } catch (_err) { }
          }
          if (audioCtx) {
            try {
              audioCtx.close();
            } catch (_err) { }
          }
          resolve(file);
        } catch (_err) {
          clearInterval(drawTimer);
          reject(new Error("Failed to assemble dummy video file."));
        }
      };

      rec.start(300);
      setTimeout(() => {
        try {
          rec.stop();
          mixedStream.getTracks().forEach((t) => t.stop());
        } catch (_err) {
          clearInterval(drawTimer);
          reject(new Error("Failed to stop dummy video recorder."));
        }
      }, DUMMY_DURATION_MS);
    });
  }

  /**
   * Feeds dummy video file automatically to Migaku Player dropzone.
   * @returns {Promise<boolean>} True if drop was triggered.
   */
  async function bootstrapNativePlayerByDummyDrop() {
    const input = findLocalVideoInput();
    const dropZone = findDropZone();
    if (!input && !dropZone) return false;

    const dummyFile = await generateDummyVideoFile();
    const dt = new DataTransfer();
    dt.items.add(dummyFile);

    let triggered = false;
    if (input) {
      try {
        input.files = dt.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        triggered = true;
      } catch (_err) { }
    }
    if (dropZone) {
      try {
        const dragEnter = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt });
        const dragOver = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
        const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
        dropZone.dispatchEvent(dragEnter);
        dropZone.dispatchEvent(dragOver);
        dropZone.dispatchEvent(drop);
        triggered = true;
      } catch (_err) { }
    }
    return triggered;
  }

  /**
   * Retrieves active video element. If not present, forces bootstrap with dummy video.
   * @returns {Promise<HTMLVideoElement>} Prepared video element.
   */
  async function ensureVideoForDirectInject() {
    try {
      return await ensureVideoElement(1800);
    } catch (_err) {
      setStatus("Initializing connection...", false);
      const ok = await bootstrapNativePlayerByDummyDrop();
      if (!ok) {
        throw new Error("Migaku <video> element was not found.");
      }
      const video = await ensureVideoElement(12000);

      if (video.readyState < 1) {
        await new Promise((resolve) => {
          video.addEventListener("loadedmetadata", resolve, { once: true });
          setTimeout(resolve, 2000);
        });
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
      }

      if (!video._bridgePlayPatched) {
        const originalPlay = video.play;
        video.play = function () {
          const p = originalPlay.apply(this, arguments);
          if (p !== undefined && p.catch) {
            return p.catch((e) => {
              if (e.name === "AbortError") {
                console.warn("[Bridge-Diag] Suppressed AbortError during play() to save Batch Mining", e);
                return Promise.resolve();
              }
              throw e;
            });
          }
          return p;
        };
        video._bridgePlayPatched = true;
      }

      video.isFirstBootstrap = true;
      return video;
    }
  }

  // ==========================================================================
  // 12. Controlling Playback Injection
  // ==========================================================================

  /**
   * Plays active stream in Migaku video player.
   * @param {boolean} useProxy - True if playing via local proxy server, false if direct CDN.
   * @param {boolean} isFullMode - True if Full Mode target-audio stream.
   */
  async function playStream(useProxy, isFullMode = false) {
    const info = latestStream || (await fetchCurrentStream());
    const hls = isHlsStream(info);
    const sourceUrl = useProxy ? info.proxy_url : (info.stream_url || info.m3u8_url);
    const streamKey = getStreamKey(info);
    const streamTitle = info.title || "";
    let preDuration = getCachedDurationHint(streamKey);

    if (hls && !preDuration) {
      try {
        preDuration = await fetchHlsDurationHint(info.stream_url || info.m3u8_url);
        if (preDuration > 0) {
          rememberDurationHint(preDuration, streamKey);
          window.__bridgeGlobalDurationHint = preDuration;
          console.log("[Bridge] Pre-fetched true duration before Migaku initialized:", preDuration);
        } else if (info.duration || info.duration_sec || info.duration_seconds) {
          const fallbackDuration = finiteDuration(info.duration || info.duration_sec || info.duration_seconds);
          if (fallbackDuration) {
            window.__bridgeGlobalDurationHint = fallbackDuration;
            console.log("[Bridge] Server API failed, used extension memory duration fallback:", fallbackDuration);
          }
        }
      } catch (err) { }
    }

    const video = await ensureVideoForDirectInject();
    sharedState.activeVideo = video;
    sharedState.activeVideoStreamKey = streamKey;
    sharedState.lastDurationHintKey = streamKey;

    savePlaybackSnapshot(video, sharedState.lastPlaybackKey || streamKey, sharedState.lastPlaybackTitle || streamTitle);
    destroyHls();

    attachSubtitle(video, info, useProxy);

    const restoreSec = getRestoreTime(info, streamKey);
    applyPlaybackRestore(video, restoreSec);

    bindPlaybackTracker(video, streamKey, streamTitle);
    if (preDuration) applyDurationHint(video, preDuration, streamKey);
    else void loadDurationHint(video, info, sourceUrl, hls);
    updateDurationState();

    if (isFullMode) {
      video.muted = true;
    } else {
      video.muted = false;
      if (typeof video.volume === "number" && video.volume === 0) {
        video.volume = 1;
      }
      if (video.isFirstBootstrap) {
        const antiMute = () => {
          if (video.muted) {
            console.log("[Bridge-Diag] Defeating Migaku's delayed auto-mute (Single-Shot).");
            video.muted = false;
            if (typeof video.volume === "number" && video.volume === 0) video.volume = 1;
            video.removeEventListener("volumechange", antiMute);
          }
        };
        video.addEventListener("volumechange", antiMute);
        setTimeout(() => video.removeEventListener("volumechange", antiMute), 3000);
      }
    }

    // A. HLS (.m3u8) Playback Path
    if (hls) {
      updateDurationState();

      if (video.canPlayType("application/vnd.apple.mpegurl") || video.canPlayType("application/x-mpegURL")) {
        video.src = sourceUrl;
        video.load();
        if (!isFullMode) {
          video.muted = false;
          if (typeof video.volume === "number" && video.volume === 0) video.volume = 1;
        }
        try {
          await video.play();
        } catch (_err) { }
        sharedState.lastPlaybackKey = streamKey;
        sharedState.lastPlaybackTitle = streamTitle;
        setStatus(`HLS feed active: ${info.title}`, false);
        updateDurationState();
        return;
      }

      if (window.Hls && window.Hls.isSupported && window.Hls.isSupported()) {
        if (video.isFirstBootstrap) {
          video.removeAttribute("src");
          await new Promise((r) => requestAnimationFrame(r));
          await new Promise((r) => requestAnimationFrame(r));
          video.isFirstBootstrap = false;
        }

        let networkRetryCount = 0;
        let mediaRetryCount = 0;
        let isRecreatingHls = false;

        const setupHlsPlayer = (initialPosition = 0) => {
          if (sharedState.hls) {
            try { sharedState.hls.destroy(); } catch (_err) { }
            sharedState.hls = null;
          }

          const hlsPlayer = new window.Hls({
            maxBufferLength: 120,
            maxMaxBufferLength: 300,
            backBufferLength: 90,
            enableWorker: true,
            lowLatencyMode: false,
            liveDurationInfinity: false,
            fragLoadingTimeOut: 30000,
            fragLoadingMaxRetry: 8,
            fragLoadingRetryDelay: 1000,
            fragLoadingMaxRetryTimeout: 64000,
            levelLoadingTimeOut: 20000,
            levelLoadingMaxRetry: 6,
            manifestLoadingTimeOut: 20000,
            manifestLoadingMaxRetry: 6,
          });

          hlsPlayer.attachMedia(video);
          hlsPlayer.on(window.Hls.Events.MEDIA_ATTACHED, () => {
            hlsPlayer.loadSource(sourceUrl);
          });

          sharedState.hls = hlsPlayer;

          hlsPlayer.on(window.Hls.Events.LEVEL_LOADED, function (_evt, data) {
            const duration = finiteDuration(data && data.details && data.details.totalduration);
            if (duration) applyDurationHint(video, duration, streamKey);
          });

          let hasTriggeredPlay = false;
          hlsPlayer.on(window.Hls.Events.FRAG_BUFFERED, async function () {
            if (initialPosition > 0.4 && Math.abs(video.currentTime - initialPosition) > 1) {
              try { video.currentTime = initialPosition; } catch (_err) { }
              initialPosition = 0;
            }
            if (hasTriggeredPlay) return;
            hasTriggeredPlay = true;
            if (!isFullMode) {
              video.muted = false;
              if (typeof video.volume === "number" && video.volume === 0) video.volume = 1;
            }
            try {
              await video.play();
            } catch (_err) { }
            sharedState.lastPlaybackKey = streamKey;
            sharedState.lastPlaybackTitle = streamTitle;
            setStatus(`HLS feed active: ${info.title}`, false);
            updateDurationState();
            networkRetryCount = 0;
            mediaRetryCount = 0;
            isRecreatingHls = false;
          });

          const attemptSoftRecreation = () => {
            if (isRecreatingHls) return;
            isRecreatingHls = true;
            const currentPos = video.currentTime || 0;
            console.warn("[Bridge] HLS fatal error reached limit. Executing Tier 2 soft player re-instantiation at:", currentPos);
            setStatus("HLS connection re-syncing...", false);
            setTimeout(() => {
              if (!video || sharedState.activeVideo !== video) return;
              setupHlsPlayer(currentPos);
            }, 600);
          };

          hlsPlayer.on(window.Hls.Events.ERROR, function (_evt, details) {
            if (!details) return;
            console.warn("[Bridge] HLS event error:", details.type, details.details, "fatal:", details.fatal);

            if (details.fatal) {
              switch (details.type) {
                case window.Hls.ErrorTypes.NETWORK_ERROR:
                  networkRetryCount++;
                  if (networkRetryCount <= 2) {
                    console.warn(`[Bridge] HLS fatal network error, executing Tier 1 retry (${networkRetryCount}/2)...`);
                    setTimeout(() => {
                      try { hlsPlayer.startLoad(); } catch (_e) { }
                    }, 1000);
                  } else {
                    attemptSoftRecreation();
                  }
                  break;

                case window.Hls.ErrorTypes.MEDIA_ERROR:
                  mediaRetryCount++;
                  if (mediaRetryCount === 1) {
                    console.warn("[Bridge] HLS fatal media error, recovering media error (Tier 1)...");
                    try { hlsPlayer.recoverMediaError(); } catch (_e) { }
                  } else if (mediaRetryCount === 2) {
                    console.warn("[Bridge] HLS fatal media error, swapping audio codec & recovering (Tier 1)...");
                    if (typeof hlsPlayer.swapAudioCodec === "function") {
                      try { hlsPlayer.swapAudioCodec(); } catch (_e) { }
                    }
                    try { hlsPlayer.recoverMediaError(); } catch (_e) { }
                  } else {
                    attemptSoftRecreation();
                  }
                  break;

                default:
                  console.warn("[Bridge] HLS unhandled fatal error type, attempting soft recreation...");
                  attemptSoftRecreation();
                  break;
              }
            }
          });
        };

        setupHlsPlayer(0);
        return;
      }
      throw new Error("HLS detected, but Hls.js is unavailable.");
    }

    // B. Direct Video Playback Path (MP4, etc.)
    video.src = sourceUrl;
    video.load();
    if (!isFullMode) {
      video.muted = false;
      if (typeof video.volume === "number" && video.volume === 0) video.volume = 1;
    }
    try {
      await video.play();
    } catch (_err) { }
    sharedState.lastPlaybackKey = streamKey;
    sharedState.lastPlaybackTitle = streamTitle;
    setStatus(`Direct feed active: ${info.title}`, false);
    updateDurationState();
  }

  /**
   * Periodic polling to sync active stream status from local server to UI widget.
   */
  async function autoSyncStream() {
    if (autoSyncInFlight || document.hidden) return;
    autoSyncInFlight = true;
    try {
      const current = await fetchCurrentStreamState();
      if (!current.hasStream || !current.stream_url) {
        if (latestStream) {
          latestStream = null;
          latestStreamKey = "";
          resetDurationHint("");
          sharedState.activeVideoStreamKey = "";
          sharedState.activeVideo = null;
          clearStreamPreview();
          setStatus("Sync: Awaiting active media stream...", false);
        }
        return;
      }

      const currentKey = getStreamKey(current);
      if (currentKey !== latestStreamKey) {
        latestStream = current;
        latestStreamKey = currentKey;
        resetDurationHint(currentKey);
        sharedState.activeVideo = null;
        sharedState.activeVideoStreamKey = "";
        setStreamPreview(current);
        setStatus("Sync: Media stream configuration updated.", false);
        const sourceUrl = current.proxy_url || current.stream_url || current.m3u8_url;
        void loadDurationHint(null, current, sourceUrl, isHlsStream(current));
      }
    } catch (_err) {
    } finally {
      autoSyncInFlight = false;
    }
  }

  // ==========================================================================
  // 13. Automated Subtitle Injection
  // ==========================================================================
  // Simulates subtitle (.srt) file drop directly into Migaku Player dropzone.
  // Automates subtitle loading without requiring manual drag-and-drop.

  function getSearchRoots() {
    const roots = [document];
    const queue = [document];
    const visited = new Set();
    while (queue.length) {
      const root = queue.shift();
      if (!root || visited.has(root)) continue;
      visited.add(root);
      let nodes = [];
      try {
        nodes = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
      } catch (_err) {
        nodes = [];
      }
      for (const node of nodes) {
        if (node && node.shadowRoot && !visited.has(node.shadowRoot)) {
          roots.push(node.shadowRoot);
          queue.push(node.shadowRoot);
        }
        if (node && node.tagName === "IFRAME") {
          try {
            if (node.contentDocument && !visited.has(node.contentDocument)) {
              roots.push(node.contentDocument);
              queue.push(node.contentDocument);
            }
          } catch (_err) { }
        }
      }
    }
    return roots;
  }

  function queryAllDeep(selector) {
    const out = [];
    for (const root of getSearchRoots()) {
      try {
        out.push(...Array.from(root.querySelectorAll(selector)));
      } catch (_err) { }
    }
    return out;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
    return rect.width > 4 && rect.height > 4;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Triggers subtitle menu opening in Migaku panel (to reveal hidden dropzone).
   */
  async function ensureSubtitlePanelReady() {
    const clickables = queryAllDeep("button, [role='button'], [tabindex], label, a, div, span");
    let clicked = 0;
    for (const el of clickables) {
      if (!isVisible(el)) continue;
      const text = String(el.textContent || "").toLowerCase().trim();
      if (!text) continue;
      if (text.includes("subtitle") || text.includes("subtitles") || text.includes("caption") || text === "cc") {
        try {
          el.click();
          clicked += 1;
          if (clicked >= 2) break;
        } catch (_err) { }
      }
    }
    if (clicked > 0) await sleep(250);
  }

  /**
   * Scans for <input type="file"> elements accepting .srt subtitle files.
   * @returns {Array<HTMLInputElement>} Scored and sorted file input list.
   */
  function findSubtitleFileInputs() {
    const inputs = queryAllDeep("input[type='file']");
    const scored = inputs.map(function (input, index) {
      const accept = String(input.getAttribute("accept") || "").toLowerCase();
      const parentText = String((input.parentElement && input.parentElement.textContent) || "").toLowerCase();
      let score = 0;
      if (accept.includes(".srt")) score += 100;
      if (accept.includes("text") || accept.includes("vtt") || accept.includes("ass")) score += 70;
      if (accept.includes("video")) score -= 130;
      if (parentText.includes("subtitle") || parentText.includes("caption")) score += 90;
      if (parentText.includes("video")) score -= 40;
      if (parentText.includes("target") || parentText.includes("primary")) score += 200;
      if (parentText.includes("secondary") || parentText.includes("native")) score -= 200;
      score -= index * 2;
      return { input, score };
    });
    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    return scored.map(function (x) {
      return x.input;
    });
  }

  function getVideoTextTrackCount() {
    const videos = queryAllDeep("video");
    let total = 0;
    for (const video of videos) {
      try {
        if (video && video.textTracks) total += Number(video.textTracks.length || 0);
      } catch (_err) { }
    }
    return total;
  }

  function normalizeFilenameTokens(filename) {
    const raw = String(filename || "").trim().toLowerCase();
    if (!raw) return [];
    const base = raw.replace(/\.[^.]+$/, "");
    const compact = base.replace(/[\s._-]+/g, "");
    return [raw, base, compact].filter(Boolean);
  }

  /**
   * Checks if successful subtitle filename indicator appears in Migaku page UI.
   * @param {string} filename - Subtitle filename.
   * @returns {boolean} True if indicator element matched.
   */
  function hasSubtitleFilenameIndicator(filename) {
    const tokens = normalizeFilenameTokens(filename);
    if (!tokens.length) return false;
    const candidates = queryAllDeep(
      "div, section, main, span, li, p, button, label, [class*='subtitle' i], [id*='subtitle' i], [class*='caption' i], [id*='caption' i]"
    );
    for (const el of candidates) {
      const text = String(el.textContent || "").toLowerCase().trim();
      if (!text) continue;
      const compactText = text.replace(/[\s._-]+/g, "");
      for (const tk of tokens) {
        if (text.includes(tk) || compactText.includes(tk)) return true;
      }
    }
    return false;
  }

  /**
   * Verifies if subtitle injection succeeded (by track count increase or text indicator).
   * @param {string} filename - Subtitle filename.
   * @param {number} trackCountBefore - Text track count before injection.
   * @returns {Promise<boolean>} True if loaded.
   */
  async function verifySubtitleLoaded(filename, trackCountBefore) {
    await sleep(700);
    const after = getVideoTextTrackCount();
    if (after > trackCountBefore) return true;
    return hasSubtitleFilenameIndicator(filename);
  }

  /**
   * Programmatically injects file into file-type input element.
   * @param {HTMLInputElement} input - File input element.
   * @param {File} file - Subtitle file object.
   */
  function injectViaInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * Subtitle injection algorithm for Migaku Player.
   * Scans and targets valid file input elements directly.
   * @param {string} srtContent - Raw SRT text.
   * @param {string} filename - Filename string.
   * @returns {Promise<boolean>} True if injection succeeded.
   */
  async function injectSubtitle(srtContent, filename) {
    const blob = new Blob([String(srtContent || "")], { type: "application/x-subrip" });
    const file = new File([blob], filename || "subtitle.srt", { type: "application/x-subrip" });
    const trackCountBefore = getVideoTextTrackCount();

    await ensureSubtitlePanelReady();

    const inputs = findSubtitleFileInputs();
    if (!inputs || inputs.length === 0) return false;

    const bestInput = inputs[0];
    try {
      injectViaInput(bestInput, file);
    } catch (_err) {
      return false;
    }

    for (let attempt = 1; attempt <= 4; attempt++) {
      if (await verifySubtitleLoaded(file.name, trackCountBefore)) {
        return true;
      }
      await sleep(500);
    }

    return false;
  }

  /**
   * Downloads active SRT subtitle content from local proxy and injects to Migaku.
   * @param {boolean} force - True to force re-injection.
   */
  async function injectSubtitleOnce(force) {
    if (isInjectingSubtitle) return;
    isInjectingSubtitle = true;
    try {
      const stateResp = await fetch(`${BRIDGE_ORIGIN}/api/current-stream`, { cache: "no-store" });
      if (!stateResp.ok) {
        setStatus("Subtitle error: Bridge server is offline.", true);
        return;
      }
      const state = await stateResp.json();
      const stream = state && state.stream ? state.stream : {};
      const subtitleUrl = String(stream.subtitle_url || "").trim();

      if (!subtitleUrl) {
        setStatus("Subtitle error: No subtitles captured yet.", true);
        return;
      }

      const key = [subtitleUrl, String(stream.subtitle_filename || ""), String(stream.updated_at || "")].join("|");
      if (!force && key === subtitleLastInjectedKey) return;

      const srtResp = await fetch(`${BRIDGE_ORIGIN}/proxy-subtitle-srt`, { cache: "no-store" });
      if (!srtResp.ok) return;
      const srtText = await srtResp.text();
      if (!srtText || srtText.length < 10) return;

      const ok = await injectSubtitle(srtText, String(stream.subtitle_filename || "subtitle.srt"));
      if (ok) {
        subtitleLastInjectedKey = key;
        const fname = String(stream.subtitle_filename || "").trim();
        if (fname) {
          setStatus(`Subtitle loaded: ${fname}`, false);
        } else {
          setStatus("Subtitle injection failed: missing filename.", true);
        }
      } else {
        setStatus("Subtitle injection failed: dropzone element not found.", true);
      }
    } finally {
      isInjectingSubtitle = false;
    }
  }

  /**
   * Triggers manual subtitle injection via UI button.
   */
  async function runSubtitleInjectManual() {
    if (subtitleInjectBtn) subtitleInjectBtn.disabled = true;
    setStatus("Injecting subtitles...", false);
    try {
      await injectSubtitleOnce(true);
    } finally {
      if (subtitleInjectBtn) subtitleInjectBtn.disabled = false;
    }
  }

  // ==========================================================================
  // 14. Event Listeners, Draggable Controller, Full Mode Handlers, & Hotkeys
  // ==========================================================================

  let isDragging = false;
  let dragMoved = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  /**
   * Applies saved panel position from localStorage or clamps within viewport.
   */
  function applySavedPosition() {
    try {
      const raw = localStorage.getItem(POS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.left !== "number" || typeof parsed.top !== "number") return;

      const panelWidth = panel.offsetWidth || 268;
      const panelHeight = panel.offsetHeight || 120;
      const maxLeft = Math.max(8, window.innerWidth - panelWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - panelHeight - 8);

      const clampedLeft = Math.max(8, Math.min(parsed.left, maxLeft));
      const clampedTop = Math.max(8, Math.min(parsed.top, maxTop));

      panel.style.left = `${clampedLeft}px`;
      panel.style.top = `${clampedTop}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    } catch (_err) { }
  }

  /**
   * Resets panel position to default bottom-right corner.
   */
  function resetPanelPosition() {
    try { localStorage.removeItem(POS_STORAGE_KEY); } catch (_err) { }
    panel.style.left = "";
    panel.style.top = "";
    panel.style.right = "18px";
    panel.style.bottom = "18px";
  }

  /**
   * Clamps current panel coordinates on viewport resize.
   */
  function clampPanelToViewport() {
    if (!panel.style.left || !panel.style.top) return;
    const currentLeft = parseFloat(panel.style.left);
    const currentTop = parseFloat(panel.style.top);
    if (!Number.isFinite(currentLeft) || !Number.isFinite(currentTop)) return;

    const panelWidth = panel.offsetWidth || 268;
    const panelHeight = panel.offsetHeight || 120;
    const maxLeft = Math.max(8, window.innerWidth - panelWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - panelHeight - 8);

    const clampedLeft = Math.max(8, Math.min(currentLeft, maxLeft));
    const clampedTop = Math.max(8, Math.min(currentTop, maxTop));

    panel.style.left = `${clampedLeft}px`;
    panel.style.top = `${clampedTop}px`;
  }

  const titlebarEl = panel.querySelector(".titlebar");

  const onTitlebarMouseDown = function (event) {
    if (event.button !== 0) return;
    if (event.target.closest("button") || event.target.closest("#bridge-back-btn")) return;

    isDragging = true;
    dragMoved = false;
    startX = event.clientX;
    startY = event.clientY;

    const rect = panel.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    document.addEventListener("mousemove", onDocumentMouseMove, { passive: false });
    document.addEventListener("mouseup", onDocumentMouseUp, { passive: false });
  };

  const onDocumentMouseMove = function (event) {
    if (!isDragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!dragMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      dragMoved = true;
      panel.classList.add("dragging");
    }

    if (dragMoved) {
      event.preventDefault();
      const panelWidth = panel.offsetWidth || 268;
      const panelHeight = panel.offsetHeight || 120;
      const maxLeft = Math.max(8, window.innerWidth - panelWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - panelHeight - 8);

      const targetLeft = initialLeft + dx;
      const targetTop = initialTop + dy;

      const clampedLeft = Math.max(8, Math.min(targetLeft, maxLeft));
      const clampedTop = Math.max(8, Math.min(targetTop, maxTop));

      panel.style.left = `${clampedLeft}px`;
      panel.style.top = `${clampedTop}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    }
  };

  const onDocumentMouseUp = function () {
    if (!isDragging) return;
    isDragging = false;

    document.removeEventListener("mousemove", onDocumentMouseMove);
    document.removeEventListener("mouseup", onDocumentMouseUp);

    if (dragMoved) {
      panel.classList.remove("dragging");
      const currentLeft = parseFloat(panel.style.left);
      const currentTop = parseFloat(panel.style.top);
      if (Number.isFinite(currentLeft) && Number.isFinite(currentTop)) {
        try {
          localStorage.setItem(POS_STORAGE_KEY, JSON.stringify({ left: currentLeft, top: currentTop }));
        } catch (_err) { }
      }
    }
  };

  const onTitlebarDblClick = function (event) {
    if (event.target.closest("button") || event.target.closest("#bridge-back-btn")) return;
    resetPanelPosition();
  };

  if (titlebarEl) {
    titlebarEl.addEventListener("mousedown", onTitlebarMouseDown);
    titlebarEl.addEventListener("dblclick", onTitlebarDblClick);
  }

  async function startFullMode() {
    switchView("fullmode");
    fullModeStatus.textContent = "Starting audio extraction...";
    fullModeBar.style.width = "0%";
    fullModeText.textContent = "0%";

    try {
      const startResp = await fetch(`${BRIDGE_ORIGIN}/api/extract-audio`, { method: "POST" });
      const startData = await startResp.json();
      if (startData.status === "error") throw new Error(startData.message);

      fullModePollInterval = setInterval(pollFullModeProgress, 1000);
    } catch (err) {
      fullModeStatus.textContent = `Error: ${err.message}`;
      fullModeStatus.style.color = "#ef4444";
    }
  }

  async function pollFullModeProgress() {
    try {
      const resp = await fetch(`${BRIDGE_ORIGIN}/api/extract-audio/progress`);
      const data = await resp.json();

      if (data.status === "downloading_ffmpeg") {
        fullModeStatus.textContent = data.message;
        fullModeBar.style.width = "0%";
        fullModeText.textContent = "";
      } else if (data.status === "extracting") {
        fullModeStatus.textContent = "Extracting audio from stream...";
        fullModeBar.style.width = `${data.percent}%`;
        fullModeText.textContent = `${data.percent}%`;
      } else if (data.status === "done") {
        clearInterval(fullModePollInterval);
        fullModeStatus.textContent = "Ready...";
        fullModeBar.style.width = "100%";
        fullModeText.textContent = "100%";
        await bootstrapFullModePlayer();
      } else if (data.status === "error") {
        clearInterval(fullModePollInterval);
        fullModeStatus.textContent = `Extraction failed: ${data.error}`;
        fullModeStatus.style.color = "#ef4444";
      }
    } catch (err) {
      console.error("Poll error", err);
    }
  }

  async function cancelFullMode() {
    clearInterval(fullModePollInterval);
    try {
      await fetch(`${BRIDGE_ORIGIN}/api/extract-audio/cancel`, { method: "POST" });
    } catch (e) { }
    switchView("select");
  }

  async function bootstrapFullModePlayer() {
    try {
      const resp = await fetch(`${BRIDGE_ORIGIN}/api/extract-audio/file`);
      if (!resp.ok) throw new Error("Audio file not found");
      const blob = await resp.blob();
      const fileName = (latestStream && latestStream.title)
        ? `${latestStream.title.replace(/[^a-zA-Z0-9_\-]/g, "_").replace(/_+/g, "_")}.mp4`
        : "Bridge_Audio.mp4";
      const file = new File([blob], fileName, { type: "video/mp4" });

      const dt = new DataTransfer();
      dt.items.add(file);

      let ok = false;
      const input = findLocalVideoInput();
      if (input) {
        try {
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          ok = true;
        } catch (e) { }
      }

      if (!ok) {
        const dropZone = findDropZone();
        if (dropZone && isVisible(dropZone)) {
          try {
            const dragEnter = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt });
            const dragOver = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
            const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
            dropZone.dispatchEvent(dragEnter);
            dropZone.dispatchEvent(dragOver);
            dropZone.dispatchEvent(drop);
            ok = true;
          } catch (e) { }
        }
      }

      if (ok) {
        await sleep(500);
        switchView("standard");
        setStatus("Audio extraction complete. Initializing video stream...", false);
        await playStream(true, true);
      } else {
        fullModeStatus.textContent = "Failed to find Migaku dropzone.";
        fullModeStatus.style.color = "#ef4444";
      }
    } catch (err) {
      fullModeStatus.textContent = `Error loading audio: ${err.message}`;
      fullModeStatus.style.color = "#ef4444";
    }
  }

  // Control panel click event delegation
  panel.addEventListener("click", async function (event) {
    const actionTarget = event.target.closest("[data-action]");
    if (!actionTarget) return;
    const action = actionTarget.getAttribute("data-action");

    try {
      if (action === "back-to-select") {
        event.stopPropagation();
        switchView("select");
      } else if (action === "mode-standard") {
        switchView("standard");
      } else if (action === "mode-full") {
        await startFullMode();
      } else if (action === "cancel-fullmode") {
        await cancelFullMode();
      } else if (action === "play-proxy") {
        lastUserPlayAction = Date.now();
        setStatus("Initializing proxy playback...", false);
        await playStream(true);
      } else if (action === "play-direct") {
        lastUserPlayAction = Date.now();
        setStatus("Initializing direct playback...", false);
        await playStream(false);
      } else if (action === "subtitle-inject-once") {
        await runSubtitleInjectManual();
      } else if (action === "toggle-collapse") {
        if (dragMoved) {
          dragMoved = false;
          return;
        }
        panel.classList.toggle("collapsed");
      }
    } catch (err) {
      console.error("[M-Stream Bridge]", err);
      setStatus(err && err.message ? err.message : "Playback initialization failed.", true);
    }
  });

  // Global hotkey listener (Ctrl + Alt + B) to toggle control panel visibility
  const onBridgeHotkey = function (event) {
    if (!(event.ctrlKey && event.altKey && String(event.key || "").toLowerCase() === "b")) return;
    event.preventDefault();
    if (panel.style.display === "none") {
      panel.style.display = "";
    } else {
      panel.style.display = "none";
    }
  };

  const onWindowFocus = function () {
    autoSyncStream();
  };
  const onVisibilityChange = function () {
    if (!document.hidden) autoSyncStream();
  };

  // Register main event listeners on document and window
  document.addEventListener("keydown", onBridgeHotkey, true);
  autoSyncTimer = setInterval(autoSyncStream, AUTO_SYNC_INTERVAL_MS);

  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("resize", clampPanelToViewport);
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Cleanup callback stored on global state for instance teardown
  sharedState.cleanup = function () {
    clearInterval(autoSyncTimer);

    window.removeEventListener("focus", onWindowFocus);
    window.removeEventListener("resize", clampPanelToViewport);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("keydown", onBridgeHotkey, true);
    document.removeEventListener("mousemove", onDocumentMouseMove);
    document.removeEventListener("mouseup", onDocumentMouseUp);

    if (titlebarEl) {
      titlebarEl.removeEventListener("mousedown", onTitlebarMouseDown);
      titlebarEl.removeEventListener("dblclick", onTitlebarDblClick);
    }

    destroyHls();
    try { panel.remove(); } catch (_err) { }
  };

  // ==========================================================================
  // 15. Startup Initiation
  // ==========================================================================
  applySavedPosition();
  setStatus("Bridge connected. Ready.", false);
  updateDurationState();
  autoSyncStream();
  console.log(`[M-Stream Bridge v${VERSION}] ready.`);
})();

