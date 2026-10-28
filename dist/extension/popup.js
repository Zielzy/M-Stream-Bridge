// ==M-Stream Bridge==
// @name        M-Stream Bridge
// @version     3.1.0
// @author      Zielzy
// @description Local bridge for non-DRM browser streams and Migaku Player.
// @homepage    https://github.com/Zielzy/M-Stream-Bridge
// ==/M-Stream Bridge==


const BRIDGE_ORIGIN = "http://127.0.0.1:7000", DEFAULT_MIGAKU_EXTENSION_ID = "dmeppfcidcpcocleneopiblmpnbokhep", MIGAKU_PLAYER_PATH = "/pages/player/index.html", HEALTH_RETRY_COUNT = 3, HEALTH_RETRY_DELAY_MS = 350, RECENT_ONLINE_GRACE_MS = 2500;

let latestState = null, toastTimer = null, lastServerOnlineAt = 0;

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
    toast: document.getElementById("toast")
};

function showToast(message) {
    el.toast && (el.toast.textContent = message, el.toast.classList.add("show"), clearTimeout(toastTimer), 
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 1400));
}

function setStatus(ok, text) {
    if (!el.status) return;
    const dotClass = ok ? "ok" : "bad";
    el.status.innerHTML = `<span class="status-dot ${dotClass}"></span> <span class="status-text">${text}</span>`;
}

function setServerIndicator(online) {
    el.serverLine && (el.serverLine.textContent = new URL(BRIDGE_ORIGIN).host), el.serverDot && el.serverDot.classList.toggle("online", online), 
    el.serverBadge && (el.serverBadge.textContent = online ? "ONLINE" : "OFFLINE", el.serverBadge.classList.toggle("online", online), 
    el.serverBadge.classList.toggle("offline", !online));
}

function normalizePositiveInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const i = Math.trunc(n);
    return i > 0 ? i : null;
}

function renderSeasonEpisode(season, episode) {
    el.season && (season ? (el.season.textContent = `S${String(season).padStart(2, "0")}`, 
    el.season.style.display = "inline-flex") : el.season.style.display = "none"), el.episode && (episode ? (el.episode.textContent = `EP${String(episode).padStart(2, "0")}`, 
    el.episode.style.display = "inline-flex") : el.episode.style.display = "none");
}

function compactUrl(url) {
    if (!url) return "-";
    const s = String(url);
    return s.length > 55 ? s.slice(0, 52) + "..." : s;
}

function applyStream(streamData, playbackUrl) {
    const stream = streamData || {}, streamType = String(stream.stream_type || "hls").toLowerCase(), streamUrl = stream.stream_url || stream.m3u8_url || "", title = stream.clean_title || stream.display_title || stream.title || "Captured by Bridge Extension", season = normalizePositiveInt(stream.season), episode = normalizePositiveInt(stream.episode) || normalizePositiveInt(stream.detected_episode);
    streamUrl ? (el.pill.textContent = "direct" === streamType ? "DIRECT" : "HLS", el.pill.classList.toggle("direct", "direct" === streamType), 
    el.pill.classList.toggle("hls", "direct" !== streamType), el.pill.style.display = "inline-flex") : el.pill.style.display = "none", 
    el.title.textContent = title, el.url.textContent = compactUrl(streamUrl), renderSeasonEpisode(season, episode), 
    latestState = {
        streamType: streamType
    };
}

async function fetchJson(url) {
    const resp = await fetch(url, {
        cache: "no-store"
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, attempts = 3) {
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) try {
        return await fetchJson(url);
    } catch (err) {
        lastError = err, i < attempts - 1 && await sleep(350);
    }
    throw lastError || new Error("fetch failed");
}

function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, response => {
            const err = chrome.runtime.lastError;
            err ? reject(new Error(err.message)) : resolve(response);
        });
    });
}

function chromeCallback(fn) {
    return new Promise((resolve, reject) => {
        fn(result => {
            const err = chrome.runtime.lastError;
            err ? reject(new Error(err.message)) : resolve(result);
        });
    });
}

function normalizeMigakuExtensionId(value) {
    const text = String(value || "").trim().toLowerCase();
    return /^[a-p]{32}$/.test(text) ? text : "";
}

async function loadMigakuExtensionId() {
    try {
        const stored = await chromeCallback(done => chrome.storage.local.get({
            migakuExtensionId: DEFAULT_MIGAKU_EXTENSION_ID
        }, done));
        return normalizeMigakuExtensionId(stored?.migakuExtensionId) || DEFAULT_MIGAKU_EXTENSION_ID;
    } catch (_err) {
        return DEFAULT_MIGAKU_EXTENSION_ID;
    }
}

async function openMigakuPlayerDirect() {
    const url = `chrome-extension://${await loadMigakuExtensionId()}${MIGAKU_PLAYER_PATH}`;
    try {
        const tabs = await chromeCallback(done => chrome.tabs.query({
            url: `${url}*`
        }, done)), existing = Array.isArray(tabs) ? tabs[0] : null;
        if (null != existing?.id) {
            if (null != existing.windowId && chrome.windows?.update) try {
                await chromeCallback(done => chrome.windows.update(existing.windowId, {
                    focused: !0
                }, done));
            } catch (_err) {}
            return await chromeCallback(done => chrome.tabs.update(existing.id, {
                active: !0
            }, done)), {
                ok: !0,
                reused: !0,
                url: url
            };
        }
    } catch (_err) {}
    const tab = await chromeCallback(done => chrome.tabs.create({
        url: url,
        active: !0
    }, done));
    return {
        ok: !0,
        reused: !1,
        tabId: tab?.id,
        url: url
    };
}

async function refreshState() {
    try {
        setStatus(!0, "Verifying bridge connection..."), await fetchJsonWithRetry(`${BRIDGE_ORIGIN}/health`), 
        lastServerOnlineAt = Date.now(), setServerIndicator(!0);
        const data = await fetchJsonWithRetry(`${BRIDGE_ORIGIN}/api/current-stream`, 2), hasStream = Boolean(data?.has_stream);
        applyStream(data?.stream || null, data?.playback_url || ""), setStatus(!0, hasStream ? `Bridge ready. Streaming ${latestState.streamType.toUpperCase()} feed...` : "Bridge active. Awaiting media stream...");
    } catch (err) {
        if (Date.now() - lastServerOnlineAt < 2500) return void setStatus(!0, "Bridge server is initializing...");
        setServerIndicator(!1), latestState = null, renderSeasonEpisode(null, null), el.pill && (el.pill.style.display = "none"), 
        el.title.textContent = "Bridge offline", el.url.textContent = "Run M-Stream Bridge.exe", 
        setStatus(!1, "Bridge offline. Please launch the desktop app.");
    }
}

async function openMigakuPlayer() {
    setStatus(!0, "Launching Migaku Local Player...");
    let resp = null;
    try {
        resp = await sendRuntimeMessage({
            type: "bridge_open_migaku_player"
        }), resp?.ok || "unknown_message" !== resp?.error && "unknown message" !== resp?.error || (resp = await sendRuntimeMessage({
            type: "open_migaku_player"
        }));
    } catch (_err) {}
    if (resp?.ok || (resp = await openMigakuPlayerDirect()), resp?.ok) return setStatus(!0, resp.reused ? "Switched to active Migaku Player." : "Migaku Local Player launched."), 
    void showToast(resp.reused ? "Focus Migaku" : "Open Migaku");
    throw new Error(resp?.error || "Failed to open Migaku");
}

el.openMigaku && el.openMigaku.addEventListener("click", async () => {
    try {
        await openMigakuPlayer();
    } catch (err) {
        setStatus(!1, "Failed to launch Migaku Player."), showToast("Failed to open Migaku");
    }
});

const UPDATE_CHECK_INTERVAL_MS = 432e5;

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

async function checkExtensionUpdate() {
    try {
        const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : null, currentVersion = manifest?.version || "3.1.0", cached = await chrome.storage.local.get([ "upstreamVersion", "downloadUrl", "lastUpdateCheck" ]), now = Date.now();
        let version = cached?.upstreamVersion, downloadUrl = cached?.downloadUrl || "https://github.com/Zielzy/M-Stream-Bridge/releases/latest";
        if (!version || now - (cached?.lastUpdateCheck || 0) > 432e5) {
            const resp = await fetch("https://raw.githubusercontent.com/Zielzy/M-Stream-Bridge/main/index.min.json", {
                cache: "no-store"
            });
            if (resp.ok) {
                const data = await resp.json();
                data && data.version && (version = data.version, downloadUrl = data.download_url || "https://github.com/Zielzy/M-Stream-Bridge/releases/latest", 
                await chrome.storage.local.set({
                    upstreamVersion: version,
                    downloadUrl: downloadUrl,
                    lastUpdateCheck: now
                }));
            }
        }
        if (version && isNewerVersion(version, currentVersion)) {
            const banner = document.getElementById("update-banner"), verSpan = document.getElementById("update-ver"), link = document.getElementById("update-link");
            banner && verSpan && link && (verSpan.textContent = `v${version}`, link.href = downloadUrl, 
            banner.style.display = "flex"), chrome.action?.setBadgeText && (chrome.action.setBadgeText({
                text: "UP"
            }), chrome.action.setBadgeBackgroundColor({
                color: "#7c3aed"
            }));
        }
    } catch (_e) {}
}

refreshState(), checkExtensionUpdate();
