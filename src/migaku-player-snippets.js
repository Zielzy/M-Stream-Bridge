(function () {
  "use strict";

  const VERSION = "dev";
  const BRIDGE_ORIGIN = "http://localhost:7000";
  const PANEL_ID = "__mstream_bridge_panel__";
  const STATE_KEY = "__mstream_bridge_state__";

  const oldPanel = document.getElementById(PANEL_ID);
  const oldState = window[STATE_KEY];
  if (oldState?.hls) {
    try { oldState.hls.destroy(); } catch (_err) {}
  }
  if (oldPanel) oldPanel.remove();

  const state = { hls: null, lastStream: null };
  window[STATE_KEY] = state;

  const style = document.createElement("style");
  style.textContent = `
    #${PANEL_ID} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      width: 250px;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 8px;
      background: #111318;
      color: #f5f7fb;
      box-shadow: 0 14px 34px rgba(0,0,0,.35);
      font: 13px/1.35 system-ui, -apple-system, Segoe UI, sans-serif;
      overflow: hidden;
    }
    #${PANEL_ID} * { box-sizing: border-box; }
    #${PANEL_ID} header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      background: #252a34;
      font-weight: 750;
      cursor: move;
    }
    #${PANEL_ID} .ver { color: #aab3c2; font-size: 11px; font-weight: 650; }
    #${PANEL_ID} .body { padding: 10px; }
    #${PANEL_ID} .title {
      min-height: 18px;
      margin-bottom: 6px;
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    #${PANEL_ID} .url {
      margin-bottom: 10px;
      color: #aab3c2;
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    #${PANEL_ID} .row { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
    #${PANEL_ID} button {
      height: 31px;
      border: 0;
      border-radius: 7px;
      background: #2e3440;
      color: #f5f7fb;
      font-weight: 750;
      cursor: pointer;
    }
    #${PANEL_ID} button.primary { grid-column: 1 / -1; background: #2e5f8f; }
    #${PANEL_ID} button:hover { filter: brightness(1.12); }
    #${PANEL_ID} .status {
      margin-top: 9px;
      color: #9ee6b8;
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    #${PANEL_ID} .status.err { color: #ffb1b1; }
  `;
  document.documentElement.appendChild(style);

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <header>
      <span>M-Stream Bridge</span>
      <span class="ver">v${VERSION}</span>
    </header>
    <div class="body">
      <div class="title" id="msb-title">No stream loaded</div>
      <div class="url" id="msb-url">-</div>
      <div class="row">
        <button class="primary" data-action="refresh-play">Refresh + Play</button>
        <button data-action="play-proxy">Proxy</button>
        <button data-action="play-direct">Direct</button>
      </div>
      <div class="status" id="msb-status">ready</div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  const titleEl = panel.querySelector("#msb-title");
  const urlEl = panel.querySelector("#msb-url");
  const statusEl = panel.querySelector("#msb-status");

  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle("err", Boolean(isError));
  }

  function shortUrl(value) {
    try {
      const url = new URL(value);
      return `${url.host}${url.pathname}`.slice(0, 120);
    } catch (_err) {
      return value || "-";
    }
  }

  function findVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    return videos.find((video) => video.offsetParent !== null) || videos[0] || null;
  }

  function normalize(raw) {
    const stream = raw?.stream || raw || {};
    const streamUrl = String(stream.stream_url || stream.m3u8_url || "").trim();
    const type = String(stream.stream_type || "").toLowerCase() || (/\.m3u8(?:\?|$)/i.test(streamUrl) ? "hls" : "direct");
    return {
      streamUrl,
      type,
      title: String(stream.title || "Bridge Stream").trim(),
      proxyUrl: type === "direct" ? `${BRIDGE_ORIGIN}/stream-direct` : `${BRIDGE_ORIGIN}/stream.m3u8`,
      subtitleUrl: String(stream.proxy_subtitle_srt_url || stream.proxy_subtitle_url || stream.subtitle_url || "").trim(),
    };
  }

  async function loadState() {
    const response = await fetch(`${BRIDGE_ORIGIN}/api/current-stream`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Bridge API ${response.status}`);
    const info = normalize(await response.json());
    if (!info.streamUrl) throw new Error("No active stream");
    state.lastStream = info;
    titleEl.textContent = info.title;
    urlEl.textContent = shortUrl(info.streamUrl);
    setStatus(`loaded ${info.type}`);
    return info;
  }

  function attachSubtitle(video, subtitleUrl) {
    if (!subtitleUrl) return;
    video.querySelectorAll("track[data-mstream-bridge]").forEach((track) => track.remove());
    const track = document.createElement("track");
    track.dataset.mstreamBridge = "1";
    track.kind = "subtitles";
    track.label = "Bridge";
    track.srclang = "ja";
    track.src = subtitleUrl;
    track.default = true;
    video.appendChild(track);
  }

  async function play(info, useDirect) {
    const video = findVideo();
    if (!video) throw new Error("Video element not found");

    const url = useDirect ? info.streamUrl : info.proxyUrl;
    if (state.hls) {
      try { state.hls.destroy(); } catch (_err) {}
      state.hls = null;
    }

    const isHls = !useDirect && info.type === "hls";
    if (isHls && window.Hls?.isSupported?.()) {
      state.hls = new window.Hls({ enableWorker: true });
      state.hls.loadSource(url);
      state.hls.attachMedia(video);
    } else {
      video.src = url;
    }

    attachSubtitle(video, info.subtitleUrl);
    await video.play().catch(() => {});
    setStatus(useDirect ? "playing direct" : "playing proxy");
  }

  async function run(action) {
    try {
      const info = action === "play-direct" && state.lastStream ? state.lastStream : await loadState();
      await play(info, action === "play-direct");
    } catch (err) {
      setStatus(err?.message || String(err), true);
    }
  }

  panel.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    void run(button.dataset.action);
  });

  panel.querySelector("header").addEventListener("dblclick", () => {
    panel.remove();
    if (state.hls) {
      try { state.hls.destroy(); } catch (_err) {}
    }
  });

  loadState().catch((err) => setStatus(err?.message || "Bridge offline", true));
})();
