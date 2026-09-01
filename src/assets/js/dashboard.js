// ==M-Stream Bridge==
// @name        M-Stream Bridge
// @version     __VERSION__
// @author      Zielzy
// @description Local bridge for non-DRM browser streams and Migaku Player.
// @homepage    https://github.com/Zielzy/M-Stream-Bridge
// ==/M-Stream Bridge==

/**
 * M-Stream Bridge - Local Admin Dashboard Logic (dashboard.js)
 *
 * Handles client-side interactivity and state polling for the dashboard:
 * - Theme toggling and persistent dark/light mode preference
 * - Stream status, metadata, and TMDB backdrop/poster rendering
 * - Candidate streams list and subtitle search/promotions (Jimaku & SubDL)
 * - Real-time system log streaming with collapsible viewer drawer
 * - Server configuration management and shutdown controls
 */

// ==========================================================================
// 1. Theme Management
// ==========================================================================

/**
 * Toggles dark/light mode and saves the state to localStorage.
 */
function toggleTheme() {
  const isDark = document.body.classList.toggle("dark");
  localStorage.setItem("theme", isDark ? "dark" : "light");
  updateThemeIcon(isDark);
}

/**
 * Updates the topbar theme toggle button SVG icon.
 * @param {boolean} isDark - Whether dark mode is currently active.
 */
function updateThemeIcon(isDark) {
  const icon = document.getElementById("themeIcon");
  if (!icon) return;
  if (isDark) {
    icon.innerHTML = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`;
  } else {
    icon.innerHTML = `
      <circle cx="12" cy="12" r="5"></circle>
      <line x1="12" y1="1" x2="12" y2="3"></line>
      <line x1="12" y1="21" x2="12" y2="23"></line>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
      <line x1="1" y1="12" x2="3" y2="12"></line>
      <line x1="21" y1="12" x2="23" y2="12"></line>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
    `;
  }
}

(function initTheme() {
  const savedTheme = localStorage.getItem("theme");
  const isDark = savedTheme === "dark";
  document.addEventListener("DOMContentLoaded", () => updateThemeIcon(isDark));
})();

// ==========================================================================
// 2. Global Constants & State Variables
// ==========================================================================

const VERSION = "__VERSION__";

// Determine local server origin. If opened via browser, use location.origin.
// If opened from local filesystem (file://), fallback to http://127.0.0.1:7000.
const BRIDGE = window.location.protocol.startsWith("http")
  ? window.location.origin
  : "http://127.0.0.1:7000";

const $ = (id) => document.getElementById(id);

const logBox = $("logBox");
const candidatesBox = $("candidatesBox");
const manualResultsBox = $("manualResultsBox");
const manualQuery = $("manualQuery");

let latestStream = null;
let toastTimer = null;
let logTotal = 0;
let manualQueryTouched = false;
let candidatesRenderKey = "";
let logsFetchInFlight = false;
let candidatesFetchInFlight = false;
let streamFetchInFlight = false;
let dashboardRefreshInFlight = false;
let lastFetchedTitle = "";
let lastCoverUrl = "";
let lastBannerUrl = "";

if (manualQuery) {
  manualQuery.addEventListener("input", () => {
    manualQueryTouched = true;
  });
}

// ==========================================================================
// 3. Media Artwork & Status Display
// ==========================================================================

/**
 * Updates the media cover art and blurred backdrop banner.
 * @param {string} title - Media clean title.
 * @param {string} coverUrl - URL of the poster image.
 * @param {string} bannerUrl - URL of the backdrop banner image.
 */
function updateArtwork(title, coverUrl, bannerUrl) {
  resetArtwork(false, title);

  const finalCover = coverUrl || "";
  const finalBanner = bannerUrl || finalCover;

  if (finalCover) {
    const imgCover = $("mediaCoverArt");
    if (imgCover) {
      imgCover.src = finalCover;
      imgCover.onload = () => {
        imgCover.classList.add("loaded");
        const placeholder = $("mediaCoverPlaceholder");
        if (placeholder) placeholder.style.display = "none";
      };
    }
  }

  if (finalBanner) {
    const imgBanner = $("mediaBackdrop");
    if (imgBanner) {
      imgBanner.src = finalBanner;
      imgBanner.onload = () => imgBanner.classList.add("loaded");
    }
  }
}

/**
 * Resets the media cover art and backdrop banner to initial/offline state.
 * @param {boolean} isOffline - Whether the server is currently offline.
 * @param {string} title - Fallback letter or title for initial letter display.
 */
function resetArtwork(isOffline = false, title = "M") {
  const imgCover = $("mediaCoverArt");
  if (imgCover) {
    imgCover.src = "";
    imgCover.classList.remove("loaded");
  }

  const placeholder = $("mediaCoverPlaceholder");
  if (placeholder) {
    placeholder.style.display = "flex";
    if (isOffline) {
      placeholder.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="feather feather-power" style="width: 32px; height: 32px; color: currentColor;">
          <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
          <line x1="12" y1="2" x2="12" y2="12" />
        </svg>
      `;
    } else {
      let initial = "M";
      if (title && title !== "M") {
        const cleaned = title.trim().replace(/^[^a-zA-Z0-9]+/, "");
        if (cleaned.length > 0) {
          initial = cleaned.charAt(0).toUpperCase();
        }
      }
      placeholder.innerHTML = escapeHtml(initial);
    }
  }

  const imgBanner = $("mediaBackdrop");
  if (imgBanner) {
    imgBanner.src = "";
    imgBanner.classList.remove("loaded");
  }
}

// ==========================================================================
// 4. Utility & UI Helper Functions
// ==========================================================================

/**
 * Escapes unsafe HTML characters to prevent XSS.
 * @param {*} value - The input value to escape.
 * @returns {string} Safe HTML string.
 */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\x22\x27]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

/**
 * Truncates long URLs for compact display.
 * @param {string} url - Source stream URL.
 * @returns {string} Truncated URL string.
 */
function shortUrl(url) {
  if (!url) return "-";
  const s = String(url);
  return s.length > 75 ? s.slice(0, 72) + "..." : s;
}

/**
 * Switches the active dashboard panel (Home or API Key).
 * @param {string} id - Panel ID ("home" or "api").
 */
function showPanel(id) {
  ["home", "api"].forEach((p) => {
    const el = $("panel-" + p);
    if (el) {
      el.style.display = p === id ? "flex" : "none";
      if (p === id) {
        el.style.flexDirection = "column";
        el.style.gap = "16px";
      }
    }
  });

  document.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
  const nav = document.querySelector(`.nav-item[onclick*="${id}"]`);
  if (nav) nav.classList.add("active");
}

/**
 * Displays a floating toast notification.
 * @param {string} msg - Toast message text.
 */
function toast(msg) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

/**
 * Sets the feedback status message on the API panel.
 * @param {string} msg - Feedback message.
 * @param {string} type - Status style modifier ("ok", "err", "warn").
 */
function setFeedback(msg, type = "") {
  const el = $("feedback");
  if (!el) return;
  el.textContent = msg;
  el.className = "feedback" + (type ? " " + type : "");
}

/**
 * Toggles visibility of masked password inputs.
 * @param {string} inputId - Target input element ID.
 * @param {string} btnId - Associated toggle button ID.
 */
function toggleVis(inputId, btnId) {
  const inp = document.getElementById(inputId);
  if (inp) {
    inp.type = inp.type === "password" ? "text" : "password";
  }
}

// ==========================================================================
// 5. Real-Time Clock Initialization
// ==========================================================================

setInterval(() => {
  const timeStr = new Date().toLocaleTimeString("en-US", { hour12: false });
  const clockEl = $("clock");
  if (clockEl) clockEl.textContent = timeStr;
  const statusClockEl = $("statusBarClock");
  if (statusClockEl) statusClockEl.textContent = timeStr;
}, 1000);

const initialTime = new Date().toLocaleTimeString("en-US", { hour12: false });
const clockEl = $("clock");
if (clockEl) clockEl.textContent = initialTime;
const statusClockEl = $("statusBarClock");
if (statusClockEl) statusClockEl.textContent = initialTime;

// ==========================================================================
// 6. Candidate Streams & Manual Subtitles Controller
// ==========================================================================

/**
 * Renders the captured stream candidates list.
 * @param {Array} items - Array of candidate stream objects.
 */
function renderCandidates(items) {
  if (!candidatesBox) return;
  const renderKey = JSON.stringify((items || []).map((item) => [
    item.id,
    item.active,
    item.updated_at,
    item.title,
    item.display_title,
    item.url,
    item.stream_type,
    item.season,
    item.episode,
  ]));

  if (renderKey === candidatesRenderKey) return;
  candidatesRenderKey = renderKey;

  if (!items || !items.length) {
    candidatesBox.innerHTML = `<div class="candidate-empty">No captured streams yet.</div>`;
    syncOverviewLogHeight();
    return;
  }

  candidatesBox.innerHTML = items.map((item) => {
    const title = escapeHtml(item.clean_title || item.display_title || item.title || item.source_host || item.stream_host || "Captured stream");
    const url = escapeHtml(shortUrl(item.url));
    const type = escapeHtml(String(item.stream_type || "hls").toUpperCase());
    const time = item.updated_at ? new Date(item.updated_at).toLocaleTimeString("en-US") : "-";
    const season = item.season && item.season > 0 ? `<span class="badge-season">S${String(item.season).padStart(2, "0")}</span>` : "";
    const episode = item.episode && item.episode > 0 ? `<span class="badge-ep">EP${String(item.episode).padStart(2, "0")}</span>` : "";
    const typeClass = (item.stream_type || "hls").toLowerCase() === "direct" ? "badge-direct" : "badge-hls";

    return `
      <div class="candidate-item${item.active ? " active" : ""}" onclick="useCandidate('${escapeHtml(item.id)}')">
        <div class="track-item-dot"></div>
        <div class="track-item-info">
          <div class="candidate-title">${title}</div>
          <div class="candidate-meta">
            <span class="${typeClass}">${type}</span>
            ${season}
            ${episode}
            <span class="badge-time">${escapeHtml(time)}</span>
          </div>
          <div class="candidate-url">${url}</div>
        </div>
      </div>
    `;
  }).join("");

  syncOverviewLogHeight();
}

/**
 * Renders manual subtitle search results.
 * @param {Array} items - Array of subtitle candidate items.
 */
function renderManualSubtitles(items) {
  if (!manualResultsBox) return;
  if (!items || !items.length) {
    manualResultsBox.innerHTML = `<div class="manual-empty">No subtitle files found.</div>`;
    return;
  }

  manualResultsBox.innerHTML = items.map((item) => {
    const filename = escapeHtml((item.filename || "subtitle.srt").replace(/\.zip$/i, ""));
    const entry = escapeHtml(item.entry_name || "Entry " + item.entry_id);
    const season = item.season ? "S" + String(item.season).padStart(2, "0") : "";
    const ep = item.episode ? "EP" + String(item.episode).padStart(2, "0") : "EP?";

    return `
      <div id="manual-item-${escapeHtml(item.id)}">
        <div class="manual-item" onclick="useManualSubtitle('${escapeHtml(item.id)}')">
          <div class="track-item-dot"></div>
          <div class="track-item-info">
            <div class="manual-title">${filename}</div>
            <div class="manual-meta">
              ${season ? `<span class="badge-season">${escapeHtml(season)}</span>` : ""}
              <span class="badge-ep">${escapeHtml(ep)}</span>
              <span class="badge-entry">${entry}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

/**
 * Sets feedback status message for manual subtitle actions.
 * @param {string} msg - Message text.
 * @param {string} type - Status modifier ("ok", "err", "warn").
 */
function setManualFeedback(msg, type = "") {
  const el = $("manualFeedback");
  if (!el) return;
  el.textContent = msg;
  el.className = "feedback" + (type ? " " + type : "");
}

/**
 * Searches subtitles on Jimaku or SubDL.
 * @param {string} provider - Provider key ('jimaku' | 'subdl').
 */
async function searchSubtitles(provider) {
  const input = manualQuery;
  let btnId;
  let endpoint;
  let providerName;

  if (provider === "jimaku") {
    btnId = "btnManualSearch";
    endpoint = "/api/jimaku/manual-search";
    providerName = "Jimaku";
  } else if (provider === "subdl") {
    btnId = "btnSubdlSearch";
    endpoint = "/api/subdl/manual-search";
    providerName = "Subdl";
  } else {
    return;
  }

  const btn = $(btnId);
  const query = (input?.value || latestStream?.title || "").trim();
  if (!query) {
    setManualFeedback("Query is empty.", "err");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span> Searching...`;
  }
  setManualFeedback(`searching ${providerName} files...`);

  try {
    await clearManualSubtitles();
    const r = await fetch(BRIDGE + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || "HTTP " + r.status);
    renderManualSubtitles(d.candidates || []);
    setManualFeedback(`${(d.candidates || []).length} subtitle files found.`, "ok");
  } catch (e) {
    renderManualSubtitles([]);
    setManualFeedback("search failed: " + e.message, "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `Search ${providerName}`;
    }
  }
}

/**
 * Selects and applies a manual subtitle track.
 * @param {string} id - Subtitle file ID.
 * @param {string|null} sub_filename - Target subtitle filename if nested in a package.
 */
async function useManualSubtitle(id, sub_filename = null) {
  try {
    setManualFeedback("applying subtitle...");

    const payload = { id };
    if (sub_filename) {
      payload.sub_filename = sub_filename;
    }

    const r = await fetch(BRIDGE + "/api/jimaku/manual-use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || "HTTP " + r.status);

    if (d.files && d.files.length > 0) {
      const container = document.getElementById(`manual-item-${id}`);
      if (container) {
        const existingList = container.querySelector(".manual-sublist");
        if (existingList) existingList.remove();

        const sublistHTML = `
          <div class="manual-sublist">
            ${d.files.map((f) => `<div class="manual-subitem ${f === d.filename ? "selected" : ""}" onclick="event.stopPropagation(); useManualSubtitle('${id}', '${escapeHtml(f)}')">${escapeHtml(f)}</div>`).join("")}
          </div>
        `;
        container.insertAdjacentHTML("beforeend", sublistHTML);
      }
    }

    if (d.status === "needs_selection") {
      setManualFeedback("Please select a specific episode.", "warn");
      return;
    }

    setManualFeedback("subtitle selected: " + (d.filename || "subtitle.srt"), "ok");
    toast("Manual subtitle selected.");
    await Promise.all([fetchStream(), fetchLogs()]);
  } catch (e) {
    setManualFeedback("use failed: " + e.message, "err");
  }
}

/**
 * Clears active manual subtitle search results.
 */
async function clearManualSubtitles() {
  try {
    await fetch(BRIDGE + "/api/jimaku/manual-clear", { method: "POST", cache: "no-store" });
  } catch { }
  if (manualResultsBox) {
    manualResultsBox.innerHTML = `<div class="manual-empty">No manual subtitle search yet.</div>`;
  }
  setManualFeedback("");
}

/**
 * Kept for layout compatibility.
 */
function syncOverviewLogHeight() {
  // Maintained for backward layout compatibility
}

// ==========================================================================
// 7. Log Drawer & Console Stream Viewer
// ==========================================================================

/**
 * Returns CSS level class for log entry badge.
 * @param {string} level - Log level ("ERROR" | "WARNING" | "INFO").
 * @returns {string} CSS class name.
 */
function levelClass(level) {
  const l = (level || "").toUpperCase();
  if (l === "ERROR") return "log-err";
  if (l === "WARNING" || l === "WARN") return "log-warn";
  if (l === "INFO") return "log-ok";
  return "log-acc";
}

/**
 * Toggles collapsed/expanded state of the bottom log drawer.
 */
function toggleLogDrawer() {
  const drawer = $("logDrawer");
  const arrow = $("drawerArrow");
  if (!drawer) return;
  const isCollapsed = drawer.classList.toggle("collapsed");
  if (arrow) {
    arrow.style.transform = isCollapsed ? "" : "rotate(180deg)";
  }
  if (!isCollapsed && logBox) {
    logBox.scrollTop = logBox.scrollHeight;
  }
}

/**
 * Copies log content to clipboard.
 * @param {Event} e - Click event.
 */
function copyLogs(e) {
  if (e) e.stopPropagation();
  if (!logBox) return;
  const text = Array.from(logBox.querySelectorAll(".log-row"))
    .map((line) => line.textContent)
    .join("\n");
  if (!text) {
    toast("No logs to copy");
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    toast("Logs copied!");
    const btn = document.getElementById("btnCopyLogs") || (e && e.currentTarget);
    if (btn) {
      const originalSvg = btn.innerHTML;
      btn.classList.add("copied");
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      setTimeout(() => {
        btn.innerHTML = originalSvg;
        btn.classList.remove("copied");
      }, 1500);
    }
  }).catch((err) => {
    console.error("Failed to copy logs:", err);
    toast("Failed to copy logs");
  });
}

/**
 * Appends a new log entry to the log box and updates preview.
 * @param {Object} entry - Log entry payload { ts, level, msg }.
 */
function addLogEntry(entry) {
  const d = document.createElement("div");
  d.className = "log-row";
  const cls = levelClass(entry.level);
  d.innerHTML = `<span class="log-ts">${entry.ts}</span><span class="${cls}">${entry.msg}</span>`;
  logBox.appendChild(d);
  const preview = $("logPreview");
  if (preview) {
    preview.textContent = `[${entry.level}] ${entry.msg}`;
    preview.className = "log-preview " + cls;
  }
  logBox.scrollTop = logBox.scrollHeight;
}

/**
 * Clears the visible log box contents.
 */
function clearLog() {
  if (logBox) logBox.innerHTML = "";
}

// ==========================================================================
// 8. Server Health & Stream Polling Controller
// ==========================================================================

/**
 * Checks server health via /health endpoint and updates UI status badges.
 * @returns {Promise<boolean>} True if server is online, false otherwise.
 */
async function checkServer() {
  try {
    await fetch(BRIDGE + "/health", { cache: "no-store" });
    const srvDot = $("srvDot");
    if (srvDot) srvDot.className = "srv-dot online";
    const srvText = $("srvText");
    if (srvText) srvText.textContent = "ONLINE";
    const srvBadge = $("srvBadge");
    if (srvBadge) srvBadge.className = "server-badge online";
    const statServer = $("statServer");
    if (statServer) {
      statServer.textContent = "running";
      statServer.className = "stat-v ok";
    }

    // Status bar updates
    const srvDotStatus = $("statusDot");
    if (srvDotStatus) srvDotStatus.className = "status-dot online";
    const srvTextStatus = $("statusServerText");
    if (srvTextStatus) srvTextStatus.textContent = "running";

    return true;
  } catch {
    const srvDot = $("srvDot");
    if (srvDot) srvDot.className = "srv-dot";
    const srvText = $("srvText");
    if (srvText) srvText.textContent = "OFFLINE";
    const srvBadge = $("srvBadge");
    if (srvBadge) srvBadge.className = "server-badge offline";
    const statServer = $("statServer");
    if (statServer) {
      statServer.textContent = "offline";
      statServer.className = "stat-v err";
    }

    // Status bar updates
    const srvDotStatus = $("statusDot");
    if (srvDotStatus) srvDotStatus.className = "status-dot";
    const srvTextStatus = $("statusServerText");
    if (srvTextStatus) srvTextStatus.textContent = "offline";

    latestStream = null;
    const heroPill = $("heroPill");
    if (heroPill) heroPill.style.display = "none";
    const heroTitle = $("heroTitle");
    if (heroTitle) heroTitle.textContent = "Server offline";
    const heroUrl = $("heroUrl");
    if (heroUrl) heroUrl.textContent = "-";
    const heroSeason = $("heroSeason");
    if (heroSeason) heroSeason.style.display = "none";
    const heroEp = $("heroEp");
    if (heroEp) heroEp.style.display = "none";

    const statType = $("statType");
    if (statType) statType.textContent = "-";
    const statEp = $("statEp");
    if (statEp) statEp.textContent = "-";
    const statUpdated = $("statUpdated");
    if (statUpdated) statUpdated.textContent = "-";
    const statSub = $("statSub");
    if (statSub) {
      statSub.textContent = "-";
      statSub.className = "stat-v";
    }

    const statFilename = $("statFilename");
    if (statFilename) {
      statFilename.textContent = "-";
      statFilename.removeAttribute("title");
    }

    const statJimaku = $("statJimaku");
    if (statJimaku) {
      statJimaku.textContent = "inactive";
      statJimaku.className = "stat-v err";
    }

    // Status bar detail updates
    const workerStateStatus = $("statusWorkerState");
    const workerDotStatus = $("statusWorkerDot");
    if (workerStateStatus) workerStateStatus.textContent = "inactive";
    if (workerDotStatus) {
      workerDotStatus.style.background = "#ef4444";
      workerDotStatus.style.boxShadow = "0 0 6px rgba(239, 68, 68, 0.6)";
      workerDotStatus.classList.remove("online");
    }

    const epBadge = $("statusEpBadge");
    const epSep = $("statusEpSep");
    if (epBadge && epSep) {
      epBadge.style.display = "none";
      epSep.style.display = "none";
    }

    const subtitleInfoStatus = $("statusSubtitleInfo");
    if (subtitleInfoStatus) {
      subtitleInfoStatus.textContent = "No subtitle loaded";
      subtitleInfoStatus.style.color = "rgba(203, 213, 225, 0.4)";
    }

    lastFetchedTitle = "";
    resetArtwork(true);
    return false;
  }
}

/**
 * Polls incremental server logs from /api/logs endpoint.
 */
async function fetchLogs() {
  if (logsFetchInFlight) return;
  logsFetchInFlight = true;
  try {
    const r = await fetch(`${BRIDGE}/api/logs?since=${logTotal}`, { cache: "no-store" });
    const d = await r.json();
    if (d.entries && d.entries.length) {
      d.entries.forEach(addLogEntry);
    }
    if (Number.isFinite(Number(d.total))) {
      logTotal = Number(d.total);
    }
  } catch { } finally {
    logsFetchInFlight = false;
  }
}

/**
 * Polls recent captured streams from /api/candidates.
 */
async function fetchCandidates() {
  if (candidatesFetchInFlight) return;
  candidatesFetchInFlight = true;
  try {
    const r = await fetch(BRIDGE + "/api/candidates", { cache: "no-store" });
    const d = await r.json();
    renderCandidates(d.candidates || []);
  } catch { } finally {
    candidatesFetchInFlight = false;
  }
}

/**
 * Promotes a candidate stream to active playback.
 * @param {string} id - Stream candidate ID.
 */
async function useCandidate(id) {
  try {
    const r = await fetch(BRIDGE + "/api/promote-candidate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
      cache: "no-store",
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || "HTTP " + r.status);
    toast("Stream restored.");
    await Promise.all([fetchStream(), fetchCandidates()]);
  } catch (e) {
    toast("Use failed: " + e.message);
  }
}

/**
 * Clears candidate streams list.
 */
async function clearCandidates() {
  try {
    await fetch(BRIDGE + "/api/clear-candidates", { method: "POST", cache: "no-store" });
    renderCandidates([]);
    toast("Captured streams cleared.");
  } catch { }
}

/**
 * Fetches active stream details and updates dashboard view.
 */
async function fetchStream() {
  if (streamFetchInFlight) return;
  streamFetchInFlight = true;
  try {
    const r = await fetch(BRIDGE + "/api/current-stream", { cache: "no-store" });
    const d = await r.json();
    const jimakuActive = d.jimaku_active;

    const statJimaku = $("statJimaku");
    if (statJimaku) {
      statJimaku.textContent = jimakuActive ? "active" : "inactive";
      statJimaku.className = jimakuActive ? "stat-v ok" : "stat-v warn";
    }

    // Status bar updates
    const workerStateStatus = $("statusWorkerState");
    const workerDotStatus = $("statusWorkerDot");
    if (workerStateStatus) {
      workerStateStatus.textContent = jimakuActive ? "active" : "inactive";
    }
    if (workerDotStatus) {
      workerDotStatus.style.background = jimakuActive ? "#10b981" : "#f59e0b";
      workerDotStatus.style.boxShadow = jimakuActive ? "0 0 8px rgba(16, 185, 129, 0.8)" : "0 0 6px rgba(245, 158, 11, 0.6)";
      if (jimakuActive) {
        workerDotStatus.classList.add("online");
      } else {
        workerDotStatus.classList.remove("online");
      }
    }

    if (d.has_stream) {
      const s = d.stream || {};
      latestStream = s;
      const ep = s.episode ?? s.detected_episode;
      const titleEl = $("heroTitle");
      const cleanedTitle = s.clean_title || s.display_title || s.title || "-";
      if (titleEl) titleEl.textContent = cleanedTitle;

      const currentTitle = cleanedTitle;
      const coverUrl = s.cover_url || "";
      const bannerUrl = s.banner_url || "";

      if (currentTitle !== lastFetchedTitle || coverUrl !== lastCoverUrl || bannerUrl !== lastBannerUrl) {
        lastFetchedTitle = currentTitle;
        lastCoverUrl = coverUrl;
        lastBannerUrl = bannerUrl;
        updateArtwork(currentTitle, coverUrl, bannerUrl);
      }

      if (manualQuery && !manualQueryTouched && (s.clean_title || s.display_title || s.title)) {
        let q = s.clean_title || s.display_title || s.title;
        if (s.season) q += " Season " + s.season;
        if (ep) q += " Episode " + ep;
        manualQuery.value = q;
      }

      const heroUrl = $("heroUrl");
      if (heroUrl) heroUrl.textContent = s.stream_url || "-";

      const t = (s.stream_type || "hls").toUpperCase();
      const heroPill = $("heroPill");
      if (heroPill) {
        heroPill.textContent = t;
        heroPill.style.display = "";
        heroPill.className = "pill " + (s.stream_type === "direct" ? "pill-direct" : "pill-hls");
      }

      const heroSeason = $("heroSeason");
      if (heroSeason) {
        if (s.season) {
          heroSeason.textContent = "S" + String(s.season).padStart(2, "0");
          heroSeason.style.display = "";
        } else {
          heroSeason.style.display = "none";
        }
      }

      const heroEp = $("heroEp");
      if (heroEp) {
        if (ep) {
          heroEp.textContent = "EP" + String(ep).padStart(2, "0");
          heroEp.style.display = "";
        } else {
          heroEp.style.display = "none";
        }
      }

      const statType = $("statType");
      if (statType) statType.textContent = t;
      const statEp = $("statEp");
      if (statEp) statEp.textContent = ep ? "Episode " + ep + (s.season ? " - S" + s.season : "") : "-";
      const statUpdated = $("statUpdated");
      if (statUpdated) statUpdated.textContent = s.updated_at ? new Date(s.updated_at).toLocaleTimeString("en-US") : "-";
      const statSub = $("statSub");
      if (statSub) {
        statSub.textContent = s.subtitle_url ? "available" : "-";
        statSub.className = s.subtitle_url ? "stat-v ok" : "stat-v";
      }

      const subFn = s.subtitle_filename || "-";
      const statFilename = $("statFilename");
      if (statFilename) {
        statFilename.textContent = subFn;
        if (s.subtitle_filename) {
          statFilename.title = subFn;
        } else {
          statFilename.removeAttribute("title");
        }
      }

      // Status bar subtitle updates
      const subtitleInfoStatus = $("statusSubtitleInfo");
      if (subtitleInfoStatus) {
        if (s.subtitle_filename) {
          subtitleInfoStatus.textContent = `Subtitle: ${s.subtitle_filename}`;
          subtitleInfoStatus.style.color = "#cbd5e1";
        } else {
          subtitleInfoStatus.textContent = "No subtitle loaded";
          subtitleInfoStatus.style.color = "rgba(203, 213, 225, 0.4)";
        }
      }

      // EP badge on status bar
      const epBadge = $("statusEpBadge");
      const epSep = $("statusEpSep");
      if (epBadge && epSep) {
        if (ep) {
          epBadge.textContent = "EP " + ep;
          epBadge.style.display = "inline-block";
          epSep.style.display = "inline-block";
        } else {
          epBadge.style.display = "none";
          epSep.style.display = "none";
        }
      }
    } else {
      latestStream = null;
      const heroPill = $("heroPill");
      if (heroPill) heroPill.style.display = "none";
      const heroTitle = $("heroTitle");
      if (heroTitle) heroTitle.textContent = "No active stream yet";
      const heroUrl = $("heroUrl");
      if (heroUrl) heroUrl.textContent = "-";
      const heroSeason = $("heroSeason");
      if (heroSeason) heroSeason.style.display = "none";
      const heroEp = $("heroEp");
      if (heroEp) heroEp.style.display = "none";

      const statType = $("statType");
      if (statType) statType.textContent = "-";
      const statEp = $("statEp");
      if (statEp) statEp.textContent = "-";
      const statUpdated = $("statUpdated");
      if (statUpdated) statUpdated.textContent = "-";
      const statSub = $("statSub");
      if (statSub) {
        statSub.textContent = "-";
        statSub.className = "stat-v";
      }

      const statFilename = $("statFilename");
      if (statFilename) {
        statFilename.textContent = "-";
        statFilename.removeAttribute("title");
      }

      // Status bar empty subtitle updates
      const subtitleInfoStatus = $("statusSubtitleInfo");
      if (subtitleInfoStatus) {
        subtitleInfoStatus.textContent = "No subtitle loaded";
        subtitleInfoStatus.style.color = "rgba(203, 213, 225, 0.4)";
      }
      const epBadge = $("statusEpBadge");
      const epSep = $("statusEpSep");
      if (epBadge && epSep) {
        epBadge.style.display = "none";
        epSep.style.display = "none";
      }

      lastFetchedTitle = "";
      resetArtwork();
    }
  } catch { } finally {
    streamFetchInFlight = false;
  }
}

/**
 * Fetches server configuration and sets placeholder indicators.
 */
async function fetchConfig() {
  try {
    const r = await fetch(BRIDGE + "/api/config", { cache: "no-store" });
    const d = await r.json();

    const keyInput = $("keyInput");
    if (keyInput) {
      if (d.jimaku_api_key_set) {
        keyInput.value = "";
        keyInput.placeholder = d.jimaku_api_key_preview ? `saved (${d.jimaku_api_key_preview})` : "API key saved";
      } else {
        keyInput.placeholder = "Paste Jimaku API key here";
      }
    }

    const subdlKeyInput = $("subdlKeyInput");
    if (subdlKeyInput) {
      if (d.subdl_api_key_set) {
        subdlKeyInput.value = "";
        subdlKeyInput.placeholder = d.subdl_api_key_preview ? `saved (${d.subdl_api_key_preview})` : "API key saved";
      } else {
        subdlKeyInput.placeholder = "Paste Subdl API key here";
      }
    }

    const subdlLangsInput = $("subdlLangsInput");
    if (subdlLangsInput && d.subdl_languages) {
      subdlLangsInput.value = d.subdl_languages;
    }

    if (d.jimaku_api_key_set) {
      setFeedback("Config saved on the server.", "ok");
    }
  } catch { }
}

// ==========================================================================
// 9. Configuration & Action Handlers
// ==========================================================================

/**
 * Copies the active stream URL to clipboard.
 */
async function copyUrl() {
  if (!latestStream?.stream_url) {
    toast("No URL yet");
    return;
  }
  await navigator.clipboard.writeText(latestStream.stream_url);
  toast("URL copied!");
}

/**
 * Saves API keys and subtitle language preferences to backend.
 */
async function saveKey() {
  const key = $("keyInput")?.value.trim() || "";
  const subdlKey = $("subdlKeyInput")?.value.trim() || "";
  const subdlLangs = $("subdlLangsInput")?.value.trim() || "ID";

  const payload = {};
  if (key) payload.jimaku_api_key = key;
  if (subdlKey) payload.subdl_api_key = subdlKey;
  payload.subdl_languages = subdlLangs;

  const btn = $("btnSave");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span> Saving...`;
  }
  setFeedback("sending to server...");

  try {
    const r = await fetch(BRIDGE + "/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || "HTTP " + r.status);
    setFeedback("saved. worker " + (d.jimaku_active ? "active" : "inactive"), d.jimaku_active ? "ok" : "warn");
    await fetchLogs();
    toast("Config saved!");
    await fetchStream();
    await fetchConfig();
  } catch (e) {
    setFeedback("failed: " + e.message, "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Save & Restart Server`;
    }
  }
}

// ==========================================================================
// 10. System Shutdown Dialog Controls
// ==========================================================================

const shutdownModal = document.getElementById("shutdownModal");
const shutdownCancel = document.getElementById("shutdownCancel");
const shutdownConfirm = document.getElementById("shutdownConfirm");
const btnShutdown = $("btnShutdown");

if (shutdownCancel && shutdownModal) {
  shutdownCancel.addEventListener("click", () => {
    shutdownModal.style.display = "none";
  });
}

if (shutdownModal) {
  shutdownModal.addEventListener("click", (e) => {
    if (e.target === shutdownModal) shutdownModal.style.display = "none";
  });
}

if (shutdownConfirm && shutdownModal) {
  shutdownConfirm.addEventListener("click", async () => {
    shutdownModal.style.display = "none";
    try {
      await fetch(BRIDGE + "/api/shutdown", { method: "POST", cache: "no-store" });
    } catch { }
    await fetchLogs();
    setTimeout(async () => {
      await checkServer();
      toast("Server stopped.");
    }, 800);
  });
}

if (btnShutdown && shutdownModal) {
  btnShutdown.addEventListener("click", () => {
    shutdownModal.style.display = "flex";
  });
}

// ==========================================================================
// 11. Application Version & Update Checker
// ==========================================================================

/**
 * Compares two semantic version strings.
 * @param {string} candidate - Available upstream version.
 * @param {string} current - Currently running version.
 * @returns {boolean} True if candidate is newer than current.
 */
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

/**
 * Checks GitHub repository for upstream version updates.
 */
async function checkUpdate() {
  try {
    const resp = await fetch("https://raw.githubusercontent.com/Zielzy/M-Stream-Bridge/main/index.min.json", { cache: "no-store" });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && data.version && isNewerVersion(data.version, VERSION)) {
      const el = $("toast");
      if (el) {
        el.innerHTML = `Update v${data.version} available! <a href="${data.download_url || 'https://github.com/Zielzy/M-Stream-Bridge/releases/latest'}" target="_blank" style="color: var(--primary); text-decoration: underline; font-weight: bold; margin-left: 8px;">Get it</a>`;
        el.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove("show"), 12000);
      }
    }
  } catch (_e) { }
}

// ==========================================================================
// 12. Lifecycle Initialization & Background Polling
// ==========================================================================

(async () => {
  const ok = await checkServer();
  if (ok) {
    await Promise.all([fetchStream(), fetchConfig(), fetchLogs(), fetchCandidates()]);
  }
  syncOverviewLogHeight();
  checkUpdate();
})();

/**
 * Background polling cycle for active stream and candidates.
 */
async function refreshDashboard() {
  if (dashboardRefreshInFlight || document.hidden) return;
  dashboardRefreshInFlight = true;
  try {
    const ok = await checkServer();
    if (ok) {
      await Promise.all([fetchStream(), fetchCandidates()]);
    }
    syncOverviewLogHeight();
  } finally {
    dashboardRefreshInFlight = false;
  }
}

setInterval(refreshDashboard, 5000);
setInterval(() => {
  if (!document.hidden) fetchLogs();
}, 3000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void refreshDashboard();
    void fetchLogs();
  }
});

window.addEventListener("resize", syncOverviewLogHeight);
