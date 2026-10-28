// ==M-Stream Bridge==
// @name        M-Stream Bridge
// @version     3.1.0
// @author      Zielzy
// @description Local bridge for non-DRM browser streams and Migaku Player.
// @homepage    https://github.com/Zielzy/M-Stream-Bridge
// ==/M-Stream Bridge==


function toggleTheme() {
    const isDark = document.body.classList.toggle("dark");
    localStorage.setItem("theme", isDark ? "dark" : "light"), updateThemeIcon(isDark);
}

function toggleSidebar() {
    const isCollapsed = document.body.classList.toggle("sidebar-collapsed");
    localStorage.setItem("sidebar_collapsed", isCollapsed ? "1" : "0");
}

function updateThemeIcon(isDark) {
    const icon = document.getElementById("themeIcon");
    icon && (icon.innerHTML = isDark ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>' : '\n      <circle cx="12" cy="12" r="5"></circle>\n      <line x1="12" y1="1" x2="12" y2="3"></line>\n      <line x1="12" y1="21" x2="12" y2="23"></line>\n      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>\n      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>\n      <line x1="1" y1="12" x2="3" y2="12"></line>\n      <line x1="21" y1="12" x2="23" y2="12"></line>\n      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>\n      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>\n    ');
}

!function() {
    const isDark = "dark" === localStorage.getItem("theme");
    document.addEventListener("DOMContentLoaded", () => updateThemeIcon(isDark));
}(), document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && ("b" === e.key || "B" === e.key)) {
        const activeEl = document.activeElement;
        if (activeEl && ("INPUT" === activeEl.tagName || "TEXTAREA" === activeEl.tagName)) return;
        e.preventDefault(), toggleSidebar();
    }
});

const VERSION = "3.1.0", BRIDGE = window.location.protocol.startsWith("http") ? window.location.origin : "http://127.0.0.1:7000", $ = id => document.getElementById(id), logBox = $("logBox"), candidatesBox = $("candidatesBox"), manualResultsBox = $("manualResultsBox"), manualQuery = $("manualQuery");

let latestStream = null, toastTimer = null, logTotal = 0, manualQueryTouched = !1, candidatesRenderKey = "", logsFetchInFlight = !1, candidatesFetchInFlight = !1, streamFetchInFlight = !1, dashboardRefreshInFlight = !1, lastFetchedTitle = "", lastCoverUrl = "", lastBannerUrl = "";

function updateArtwork(title, coverUrl, bannerUrl) {
    resetArtwork(!1, title);
    const finalCover = coverUrl || "", finalBanner = bannerUrl || finalCover;
    if (finalCover) {
        const imgCover = $("mediaCoverArt");
        imgCover && (imgCover.src = finalCover, imgCover.onload = () => {
            imgCover.classList.add("loaded");
            const placeholder = $("mediaCoverPlaceholder");
            placeholder && (placeholder.style.display = "none");
        });
    }
    if (finalBanner) {
        const imgBanner = $("mediaBackdrop");
        imgBanner && (imgBanner.src = finalBanner, imgBanner.onload = () => imgBanner.classList.add("loaded"));
    }
}

function resetArtwork(isOffline = !1, title = "M") {
    const imgCover = $("mediaCoverArt");
    imgCover && (imgCover.src = "", imgCover.classList.remove("loaded"));
    const placeholder = $("mediaCoverPlaceholder");
    if (placeholder) if (placeholder.style.display = "flex", isOffline) placeholder.innerHTML = '\n        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="feather feather-power" style="width: 32px; height: 32px; color: currentColor;">\n          <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />\n          <line x1="12" y1="2" x2="12" y2="12" />\n        </svg>\n      '; else {
        let initial = "M";
        if (title && "M" !== title) {
            const cleaned = title.trim().replace(/^[^a-zA-Z0-9]+/, "");
            cleaned.length > 0 && (initial = cleaned.charAt(0).toUpperCase());
        }
        placeholder.innerHTML = escapeHtml(initial);
    }
    const imgBanner = $("mediaBackdrop");
    imgBanner && (imgBanner.src = "", imgBanner.classList.remove("loaded"));
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>\x22\x27]/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[ch]));
}

function shortUrl(url) {
    if (!url) return "-";
    const s = String(url);
    return s.length > 75 ? s.slice(0, 72) + "..." : s;
}

function showPanel(id) {
    [ "home", "api" ].forEach(p => {
        const el = $("panel-" + p);
        el && (el.style.display = p === id ? "flex" : "none", p === id && (el.style.flexDirection = "column", 
        el.style.gap = "16px"));
    }), document.querySelectorAll(".nav-item").forEach(el => el.classList.remove("active"));
    const nav = document.querySelector(`.nav-item[onclick*="${id}"]`);
    nav && nav.classList.add("active");
}

function toast(msg) {
    const el = $("toast");
    el && (el.textContent = msg, el.classList.add("show"), clearTimeout(toastTimer), 
    toastTimer = setTimeout(() => el.classList.remove("show"), 1800));
}

function setFeedback(msg, type = "") {
    const el = $("feedback");
    el && (el.textContent = msg, el.className = "feedback" + (type ? " " + type : ""));
}

function toggleVis(inputId, btnId) {
    const inp = document.getElementById(inputId);
    inp && (inp.type = "password" === inp.type ? "text" : "password");
}

manualQuery && manualQuery.addEventListener("input", () => {
    manualQueryTouched = !0;
}), setInterval(() => {
    const timeStr = (new Date).toLocaleTimeString("en-US", {
        hour12: !1
    }), clockEl = $("clock");
    clockEl && (clockEl.textContent = timeStr);
    const statusClockEl = $("statusBarClock");
    statusClockEl && (statusClockEl.textContent = timeStr);
}, 1e3);

const initialTime = (new Date).toLocaleTimeString("en-US", {
    hour12: !1
}), clockEl = $("clock");

clockEl && (clockEl.textContent = initialTime);

const statusClockEl = $("statusBarClock");

function renderCandidates(items) {
    if (!candidatesBox) return;
    const renderKey = JSON.stringify((items || []).map(item => [ item.id, item.active, item.updated_at, item.title, item.display_title, item.url, item.stream_type, item.season, item.episode ]));
    if (renderKey !== candidatesRenderKey) {
        if (candidatesRenderKey = renderKey, !items || !items.length) return candidatesBox.innerHTML = '<div class="candidate-empty">No captured streams yet.</div>', 
        void syncOverviewLogHeight();
        candidatesBox.innerHTML = items.map(item => {
            const title = escapeHtml(item.clean_title || item.display_title || item.title || item.source_host || item.stream_host || "Captured stream"), url = escapeHtml(shortUrl(item.url)), type = escapeHtml(String(item.stream_type || "hls").toUpperCase()), time = item.updated_at ? new Date(item.updated_at).toLocaleTimeString("en-US") : "-", season = item.season && item.season > 0 ? `<span class="badge-season">S${String(item.season).padStart(2, "0")}</span>` : "", episode = item.episode && item.episode > 0 ? `<span class="badge-ep">EP${String(item.episode).padStart(2, "0")}</span>` : "", typeClass = "direct" === (item.stream_type || "hls").toLowerCase() ? "badge-direct" : "badge-hls";
            return `\n      <div class="candidate-item${item.active ? " active" : ""}" onclick="useCandidate('${escapeHtml(item.id)}')">\n        <div class="track-item-dot"></div>\n        <div class="track-item-info">\n          <div class="candidate-title">${title}</div>\n          <div class="candidate-meta">\n            <span class="${typeClass}">${type}</span>\n            ${season}\n            ${episode}\n            <span class="badge-time">${escapeHtml(time)}</span>\n          </div>\n          <div class="candidate-url">${url}</div>\n        </div>\n      </div>\n    `;
        }).join(""), syncOverviewLogHeight();
    }
}

function renderManualSubtitles(items) {
    manualResultsBox && (items && items.length ? manualResultsBox.innerHTML = items.map(item => {
        const filename = escapeHtml((item.filename || "subtitle.srt").replace(/\.zip$/i, "")), entry = escapeHtml(item.entry_name || "Entry " + item.entry_id), season = item.season ? "S" + String(item.season).padStart(2, "0") : "", ep = item.episode ? "EP" + String(item.episode).padStart(2, "0") : "EP?";
        return `\n      <div id="manual-item-${escapeHtml(item.id)}">\n        <div class="manual-item" onclick="useManualSubtitle('${escapeHtml(item.id)}')">\n          <div class="track-item-dot"></div>\n          <div class="track-item-info">\n            <div class="manual-title">${filename}</div>\n            <div class="manual-meta">\n              ${season ? `<span class="badge-season">${escapeHtml(season)}</span>` : ""}\n              <span class="badge-ep">${escapeHtml(ep)}</span>\n              <span class="badge-entry">${entry}</span>\n            </div>\n          </div>\n        </div>\n      </div>\n    `;
    }).join("") : manualResultsBox.innerHTML = '<div class="manual-empty">No subtitle files found.</div>');
}

function setManualFeedback(msg, type = "") {
    const el = $("manualFeedback");
    el && (el.textContent = msg, el.className = "feedback" + (type ? " " + type : ""));
}

async function searchSubtitles(provider) {
    const input = manualQuery;
    let btnId, endpoint, providerName;
    if ("jimaku" === provider) btnId = "btnManualSearch", endpoint = "/api/jimaku/manual-search", 
    providerName = "Jimaku"; else {
        if ("subdl" !== provider) return;
        btnId = "btnSubdlSearch", endpoint = "/api/subdl/manual-search", providerName = "SubDL";
    }
    const btn = $(btnId), query = (input?.value || latestStream?.title || "").trim();
    if (query) {
        btn && (btn.disabled = !0, btn.innerHTML = '<span class="spin"></span> Searching...'), 
        setManualFeedback(`searching ${providerName} files...`);
        try {
            await clearManualSubtitles();
            const r = await fetch(BRIDGE + endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    query: query
                }),
                cache: "no-store"
            }), d = await r.json();
            if (!r.ok) throw new Error(d.message || "HTTP " + r.status);
            renderManualSubtitles(d.candidates || []), setManualFeedback(`${(d.candidates || []).length} subtitle files found.`, "ok");
        } catch (e) {
            renderManualSubtitles([]), setManualFeedback("search failed: " + e.message, "err");
        } finally {
            btn && (btn.disabled = !1, btn.innerHTML = `Search ${providerName}`);
        }
    } else setManualFeedback("Query is empty.", "err");
}

async function useManualSubtitle(id, sub_filename = null) {
    try {
        setManualFeedback("applying subtitle...");
        const payload = {
            id: id
        };
        sub_filename && (payload.sub_filename = sub_filename);
        const r = await fetch(BRIDGE + "/api/jimaku/manual-use", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            cache: "no-store"
        }), d = await r.json();
        if (!r.ok) throw new Error(d.message || "HTTP " + r.status);
        if (d.files && d.files.length > 0) {
            const container = document.getElementById(`manual-item-${id}`);
            if (container) {
                const existingList = container.querySelector(".manual-sublist");
                existingList && existingList.remove();
                const sublistHTML = `\n          <div class="manual-sublist">\n            ${d.files.map(f => `<div class="manual-subitem ${f === d.filename ? "selected" : ""}" onclick="event.stopPropagation(); useManualSubtitle('${id}', '${escapeHtml(f)}')">${escapeHtml(f)}</div>`).join("")}\n          </div>\n        `;
                container.insertAdjacentHTML("beforeend", sublistHTML);
            }
        }
        if ("needs_selection" === d.status) return void setManualFeedback("Please select a specific episode.", "warn");
        setManualFeedback("subtitle selected: " + (d.filename || "subtitle.srt"), "ok"), 
        toast("Manual subtitle selected."), await Promise.all([ fetchStream(), fetchLogs() ]);
    } catch (e) {
        setManualFeedback("use failed: " + e.message, "err");
    }
}

async function clearManualSubtitles() {
    try {
        await fetch(BRIDGE + "/api/jimaku/manual-clear", {
            method: "POST",
            cache: "no-store"
        });
    } catch {}
    manualResultsBox && (manualResultsBox.innerHTML = '<div class="manual-empty">No manual subtitle search yet.</div>'), 
    setManualFeedback("");
}

function syncOverviewLogHeight() {}

function levelClass(level) {
    const l = (level || "").toUpperCase();
    return "ERROR" === l ? "log-err" : "WARNING" === l || "WARN" === l ? "log-warn" : "INFO" === l ? "log-ok" : "log-acc";
}

function toggleLogDrawer() {
    const drawer = $("logDrawer"), arrow = $("drawerArrow");
    if (!drawer) return;
    const isCollapsed = drawer.classList.toggle("collapsed");
    arrow && (arrow.style.transform = isCollapsed ? "" : "rotate(180deg)"), !isCollapsed && logBox && (logBox.scrollTop = logBox.scrollHeight);
}

function copyLogs(e) {
    if (e && e.stopPropagation(), !logBox) return;
    const text = Array.from(logBox.querySelectorAll(".log-row")).map(line => line.textContent).join("\n");
    text ? navigator.clipboard.writeText(text).then(() => {
        toast("Logs copied!");
        const btn = document.getElementById("btnCopyLogs") || e && e.currentTarget;
        if (btn) {
            const originalSvg = btn.innerHTML;
            btn.classList.add("copied"), btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>', 
            setTimeout(() => {
                btn.innerHTML = originalSvg, btn.classList.remove("copied");
            }, 1500);
        }
    }).catch(err => {
        toast("Failed to copy logs");
    }) : toast("No logs to copy");
}

function addLogEntry(entry) {
    const d = document.createElement("div");
    d.className = "log-row";
    const cls = levelClass(entry.level);
    d.innerHTML = `<span class="log-ts">${entry.ts}</span><span class="${cls}">${entry.msg}</span>`, 
    logBox.appendChild(d);
    const preview = $("logPreview");
    preview && (preview.textContent = `[${entry.level}] ${entry.msg}`, preview.className = "log-preview " + cls), 
    logBox.scrollTop = logBox.scrollHeight;
}

function clearLog() {
    logBox && (logBox.innerHTML = "");
}

async function checkServer() {
    try {
        await fetch(BRIDGE + "/health", {
            cache: "no-store"
        });
        const srvDot = $("srvDot");
        srvDot && (srvDot.className = "srv-dot online");
        const srvText = $("srvText");
        srvText && (srvText.textContent = "ONLINE");
        const srvBadge = $("srvBadge");
        srvBadge && (srvBadge.className = "server-badge online");
        const statServer = $("statServer");
        statServer && (statServer.textContent = "running", statServer.className = "stat-v ok");
        const srvDotStatus = $("statusDot");
        srvDotStatus && (srvDotStatus.className = "status-dot online");
        const srvTextStatus = $("statusServerText");
        return srvTextStatus && (srvTextStatus.textContent = "running"), !0;
    } catch {
        const srvDot = $("srvDot");
        srvDot && (srvDot.className = "srv-dot");
        const srvText = $("srvText");
        srvText && (srvText.textContent = "OFFLINE");
        const srvBadge = $("srvBadge");
        srvBadge && (srvBadge.className = "server-badge offline");
        const statServer = $("statServer");
        statServer && (statServer.textContent = "offline", statServer.className = "stat-v err");
        const srvDotStatus = $("statusDot");
        srvDotStatus && (srvDotStatus.className = "status-dot");
        const srvTextStatus = $("statusServerText");
        srvTextStatus && (srvTextStatus.textContent = "offline"), latestStream = null;
        const heroPill = $("heroPill");
        heroPill && (heroPill.style.display = "none");
        const heroTitle = $("heroTitle");
        heroTitle && (heroTitle.textContent = "Server offline");
        const heroUrl = $("heroUrl");
        heroUrl && (heroUrl.textContent = "-");
        const heroSeason = $("heroSeason");
        heroSeason && (heroSeason.style.display = "none");
        const heroEp = $("heroEp");
        heroEp && (heroEp.style.display = "none");
        const statType = $("statType");
        statType && (statType.textContent = "-");
        const statEp = $("statEp");
        statEp && (statEp.textContent = "-");
        const statUpdated = $("statUpdated");
        statUpdated && (statUpdated.textContent = "-");
        const statSub = $("statSub");
        statSub && (statSub.textContent = "-", statSub.className = "stat-v");
        const statFilename = $("statFilename");
        statFilename && (statFilename.textContent = "-", statFilename.removeAttribute("title"));
        const statJimaku = $("statJimaku");
        statJimaku && (statJimaku.textContent = "inactive", statJimaku.className = "stat-v err");
        const workerStateStatus = $("statusWorkerState"), workerDotStatus = $("statusWorkerDot");
        workerStateStatus && (workerStateStatus.textContent = "inactive"), workerDotStatus && (workerDotStatus.style.background = "#ef4444", 
        workerDotStatus.style.boxShadow = "0 0 6px rgba(239, 68, 68, 0.6)", workerDotStatus.classList.remove("online"));
        const epBadge = $("statusEpBadge"), epSep = $("statusEpSep");
        epBadge && epSep && (epBadge.style.display = "none", epSep.style.display = "none");
        const subtitleInfoStatus = $("statusSubtitleInfo");
        return subtitleInfoStatus && (subtitleInfoStatus.textContent = "No subtitle loaded", 
        subtitleInfoStatus.style.color = "rgba(203, 213, 225, 0.4)"), lastFetchedTitle = "", 
        resetArtwork(!0), !1;
    }
}

async function fetchLogs() {
    if (!logsFetchInFlight) {
        logsFetchInFlight = !0;
        try {
            const r = await fetch(`${BRIDGE}/api/logs?since=${logTotal}`, {
                cache: "no-store"
            }), d = await r.json();
            d.entries && d.entries.length && d.entries.forEach(addLogEntry), Number.isFinite(Number(d.total)) && (logTotal = Number(d.total));
        } catch {} finally {
            logsFetchInFlight = !1;
        }
    }
}

async function fetchCandidates() {
    if (!candidatesFetchInFlight) {
        candidatesFetchInFlight = !0;
        try {
            const r = await fetch(BRIDGE + "/api/candidates", {
                cache: "no-store"
            });
            renderCandidates((await r.json()).candidates || []);
        } catch {} finally {
            candidatesFetchInFlight = !1;
        }
    }
}

async function useCandidate(id) {
    try {
        const r = await fetch(BRIDGE + "/api/promote-candidate", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                id: id
            }),
            cache: "no-store"
        }), d = await r.json();
        if (!r.ok) throw new Error(d.message || "HTTP " + r.status);
        toast("Stream restored."), await Promise.all([ fetchStream(), fetchCandidates() ]);
    } catch (e) {
        toast("Use failed: " + e.message);
    }
}

async function clearCandidates() {
    try {
        await fetch(BRIDGE + "/api/clear-candidates", {
            method: "POST",
            cache: "no-store"
        }), renderCandidates([]), toast("Captured streams cleared.");
    } catch {}
}

async function fetchStream() {
    if (!streamFetchInFlight) {
        streamFetchInFlight = !0;
        try {
            const r = await fetch(BRIDGE + "/api/current-stream", {
                cache: "no-store"
            }), d = await r.json(), jimakuActive = d.jimaku_active, statJimaku = $("statJimaku");
            statJimaku && (statJimaku.textContent = jimakuActive ? "active" : "inactive", statJimaku.className = jimakuActive ? "stat-v ok" : "stat-v warn");
            const workerStateStatus = $("statusWorkerState"), workerDotStatus = $("statusWorkerDot");
            if (workerStateStatus && (workerStateStatus.textContent = jimakuActive ? "active" : "inactive"), 
            workerDotStatus && (workerDotStatus.style.background = jimakuActive ? "#10b981" : "#f59e0b", 
            workerDotStatus.style.boxShadow = jimakuActive ? "0 0 8px rgba(16, 185, 129, 0.8)" : "0 0 6px rgba(245, 158, 11, 0.6)", 
            jimakuActive ? workerDotStatus.classList.add("online") : workerDotStatus.classList.remove("online")), 
            d.has_stream) {
                const s = d.stream || {};
                latestStream = s;
                const ep = s.episode ?? s.detected_episode, titleEl = $("heroTitle"), cleanedTitle = s.clean_title || s.display_title || s.title || "-";
                titleEl && (titleEl.textContent = cleanedTitle);
                const currentTitle = cleanedTitle, coverUrl = s.cover_url || "", bannerUrl = s.banner_url || "";
                if (currentTitle === lastFetchedTitle && coverUrl === lastCoverUrl && bannerUrl === lastBannerUrl || (lastFetchedTitle = currentTitle, 
                lastCoverUrl = coverUrl, lastBannerUrl = bannerUrl, updateArtwork(currentTitle, coverUrl, bannerUrl)), 
                manualQuery && !manualQueryTouched && (s.clean_title || s.display_title || s.title)) {
                    let q = s.clean_title || s.display_title || s.title;
                    s.season && (q += " Season " + s.season), ep && (q += " Episode " + ep), manualQuery.value = q;
                }
                const heroUrl = $("heroUrl");
                heroUrl && (heroUrl.textContent = s.stream_url || "-");
                const t = (s.stream_type || "hls").toUpperCase(), heroPill = $("heroPill");
                heroPill && (heroPill.textContent = t, heroPill.style.display = "", heroPill.className = "pill " + ("direct" === s.stream_type ? "pill-direct" : "pill-hls"));
                const heroSeason = $("heroSeason");
                heroSeason && (s.season ? (heroSeason.textContent = "S" + String(s.season).padStart(2, "0"), 
                heroSeason.style.display = "") : heroSeason.style.display = "none");
                const heroEp = $("heroEp");
                heroEp && (ep ? (heroEp.textContent = "EP" + String(ep).padStart(2, "0"), heroEp.style.display = "") : heroEp.style.display = "none");
                const statType = $("statType");
                statType && (statType.textContent = t);
                const statEp = $("statEp");
                statEp && (statEp.textContent = ep ? "Episode " + ep + (s.season ? " - S" + s.season : "") : "-");
                const statUpdated = $("statUpdated");
                statUpdated && (statUpdated.textContent = s.updated_at ? new Date(s.updated_at).toLocaleTimeString("en-US") : "-");
                const statSub = $("statSub");
                statSub && (statSub.textContent = s.subtitle_url ? "available" : "-", statSub.className = s.subtitle_url ? "stat-v ok" : "stat-v");
                const subFn = s.subtitle_filename || "-", statFilename = $("statFilename");
                statFilename && (statFilename.textContent = subFn, s.subtitle_filename ? statFilename.title = subFn : statFilename.removeAttribute("title"));
                const subtitleInfoStatus = $("statusSubtitleInfo");
                subtitleInfoStatus && (s.subtitle_filename ? (subtitleInfoStatus.textContent = `Subtitle: ${s.subtitle_filename}`, 
                subtitleInfoStatus.style.color = "#cbd5e1") : (subtitleInfoStatus.textContent = "No subtitle loaded", 
                subtitleInfoStatus.style.color = "rgba(203, 213, 225, 0.4)"));
                const epBadge = $("statusEpBadge"), epSep = $("statusEpSep");
                epBadge && epSep && (ep ? (epBadge.textContent = "EP " + ep, epBadge.style.display = "inline-block", 
                epSep.style.display = "inline-block") : (epBadge.style.display = "none", epSep.style.display = "none"));
            } else {
                latestStream = null;
                const heroPill = $("heroPill");
                heroPill && (heroPill.style.display = "none");
                const heroTitle = $("heroTitle");
                heroTitle && (heroTitle.textContent = "No active stream yet");
                const heroUrl = $("heroUrl");
                heroUrl && (heroUrl.textContent = "-");
                const heroSeason = $("heroSeason");
                heroSeason && (heroSeason.style.display = "none");
                const heroEp = $("heroEp");
                heroEp && (heroEp.style.display = "none");
                const statType = $("statType");
                statType && (statType.textContent = "-");
                const statEp = $("statEp");
                statEp && (statEp.textContent = "-");
                const statUpdated = $("statUpdated");
                statUpdated && (statUpdated.textContent = "-");
                const statSub = $("statSub");
                statSub && (statSub.textContent = "-", statSub.className = "stat-v");
                const statFilename = $("statFilename");
                statFilename && (statFilename.textContent = "-", statFilename.removeAttribute("title"));
                const subtitleInfoStatus = $("statusSubtitleInfo");
                subtitleInfoStatus && (subtitleInfoStatus.textContent = "No subtitle loaded", subtitleInfoStatus.style.color = "rgba(203, 213, 225, 0.4)");
                const epBadge = $("statusEpBadge"), epSep = $("statusEpSep");
                epBadge && epSep && (epBadge.style.display = "none", epSep.style.display = "none"), 
                lastFetchedTitle = "", resetArtwork();
            }
        } catch {} finally {
            streamFetchInFlight = !1;
        }
    }
}

async function fetchConfig() {
    try {
        const r = await fetch(BRIDGE + "/api/config", {
            cache: "no-store"
        }), d = await r.json(), keyInput = $("keyInput");
        keyInput && (d.jimaku_api_key_set ? (keyInput.value = "", keyInput.placeholder = d.jimaku_api_key_preview ? `saved (${d.jimaku_api_key_preview})` : "API key saved") : keyInput.placeholder = "Paste Jimaku API key here");
        const subdlKeyInput = $("subdlKeyInput");
        subdlKeyInput && (d.subdl_api_key_set ? (subdlKeyInput.value = "", subdlKeyInput.placeholder = d.subdl_api_key_preview ? `saved (${d.subdl_api_key_preview})` : "API key saved") : subdlKeyInput.placeholder = "Paste SubDL API key here");
        const subdlLangsInput = $("subdlLangsInput");
        subdlLangsInput && d.subdl_languages && (subdlLangsInput.value = d.subdl_languages), 
        d.jimaku_api_key_set && setFeedback("Config saved on the server.", "ok");
    } catch {}
}

async function copyUrl() {
    latestStream?.stream_url ? (await navigator.clipboard.writeText(latestStream.stream_url), 
    toast("URL copied!")) : toast("No URL yet");
}

async function saveKey() {
    const key = $("keyInput")?.value.trim() || "", subdlKey = $("subdlKeyInput")?.value.trim() || "", subdlLangs = $("subdlLangsInput")?.value.trim() || "ID", payload = {};
    key && (payload.jimaku_api_key = key), subdlKey && (payload.subdl_api_key = subdlKey), 
    payload.subdl_languages = subdlLangs;
    const btn = $("btnSave");
    btn && (btn.disabled = !0, btn.innerHTML = '<span class="spin"></span> Saving...'), 
    setFeedback("sending to server...");
    try {
        const r = await fetch(BRIDGE + "/api/config", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            cache: "no-store"
        }), d = await r.json();
        if (!r.ok) throw new Error(d.message || "HTTP " + r.status);
        setFeedback("saved. worker " + (d.jimaku_active ? "active" : "inactive"), d.jimaku_active ? "ok" : "warn"), 
        await fetchLogs(), toast("Config saved!"), await fetchStream(), await fetchConfig();
    } catch (e) {
        setFeedback("failed: " + e.message, "err");
    } finally {
        btn && (btn.disabled = !1, btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Save & Restart Server');
    }
}

statusClockEl && (statusClockEl.textContent = initialTime);

const shutdownModal = document.getElementById("shutdownModal"), shutdownCancel = document.getElementById("shutdownCancel"), shutdownConfirm = document.getElementById("shutdownConfirm"), btnShutdown = $("btnShutdown");

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

async function checkUpdate() {
    try {
        const resp = await fetch("https://raw.githubusercontent.com/Zielzy/M-Stream-Bridge/main/index.min.json", {
            cache: "no-store"
        });
        if (!resp.ok) return;
        const data = await resp.json();
        if (data && data.version && isNewerVersion(data.version, "3.1.0")) {
            const el = $("toast");
            el && (el.innerHTML = `Update v${data.version} available! <a href="${data.download_url || "https://github.com/Zielzy/M-Stream-Bridge/releases/latest"}" target="_blank" style="color: #a78bfa; text-decoration: underline; font-weight: bold; margin-left: 8px;">Get it</a>`, 
            el.classList.add("show"), clearTimeout(toastTimer), toastTimer = setTimeout(() => el.classList.remove("show"), 12e3));
        }
    } catch (_e) {}
}

async function refreshDashboard() {
    if (!dashboardRefreshInFlight && !document.hidden) {
        dashboardRefreshInFlight = !0;
        try {
            await checkServer() && await Promise.all([ fetchStream(), fetchCandidates() ]), 
            syncOverviewLogHeight();
        } finally {
            dashboardRefreshInFlight = !1;
        }
    }
}

shutdownCancel && shutdownModal && shutdownCancel.addEventListener("click", () => {
    shutdownModal.style.display = "none";
}), shutdownModal && shutdownModal.addEventListener("click", e => {
    e.target === shutdownModal && (shutdownModal.style.display = "none");
}), shutdownConfirm && shutdownModal && shutdownConfirm.addEventListener("click", async () => {
    shutdownModal.style.display = "none";
    try {
        await fetch(BRIDGE + "/api/shutdown", {
            method: "POST",
            cache: "no-store"
        });
    } catch {}
    await fetchLogs(), setTimeout(async () => {
        await checkServer(), toast("Server stopped.");
    }, 800);
}), btnShutdown && shutdownModal && btnShutdown.addEventListener("click", () => {
    shutdownModal.style.display = "flex";
}), (async () => {
    await checkServer() && await Promise.all([ fetchStream(), fetchConfig(), fetchLogs(), fetchCandidates() ]), 
    syncOverviewLogHeight(), checkUpdate();
})(), setInterval(refreshDashboard, 5e3), setInterval(() => {
    document.hidden || fetchLogs();
}, 3e3), document.addEventListener("visibilitychange", () => {
    document.hidden || (refreshDashboard(), fetchLogs());
}), window.addEventListener("resize", syncOverviewLogHeight);
