const BRIDGE_ORIGIN = "http://localhost:7000";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  server: $("server"),
  type: $("stream-type"),
  title: $("stream-title"),
  url: $("stream-url"),
  open: $("open-migaku"),
  proxy: $("open-proxy"),
  direct: $("open-direct"),
  refresh: $("refresh"),
};

let currentStream = null;

function setStatus(ok, text) {
  els.status.textContent = text;
  els.status.className = ok ? "ok" : "bad";
  els.server.textContent = ok ? "ONLINE" : "OFFLINE";
  els.server.className = ok ? "badge on" : "badge";
}

function shortUrl(value) {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}`.slice(0, 96);
  } catch (_err) {
    return value || "-";
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function refresh() {
  try {
    await fetchJson(`${BRIDGE_ORIGIN}/health`);
    const data = await fetchJson(`${BRIDGE_ORIGIN}/api/current-stream`);
    const stream = data.stream || data;
    currentStream = stream?.stream_url ? stream : null;
    setStatus(true, currentStream ? "stream ready" : "waiting stream");
    els.type.textContent = currentStream?.stream_type || "-";
    els.title.textContent = currentStream?.title || "No stream captured";
    els.url.textContent = shortUrl(currentStream?.stream_url);
  } catch (_err) {
    currentStream = null;
    setStatus(false, "server offline");
    els.type.textContent = "-";
    els.title.textContent = "Run server first";
    els.url.textContent = "python \"server proxy/server.py\"";
  }
}

function openUrl(url) {
  if (!url) return;
  chrome.tabs.create({ url });
}

async function openMigaku() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "bridge_open_migaku_player" });
    if (!response?.ok) throw new Error(response?.error || "failed");
  } catch (err) {
    setStatus(false, err?.message || "failed to open Migaku");
  }
}

els.refresh.addEventListener("click", refresh);
els.open.addEventListener("click", openMigaku);
els.proxy.addEventListener("click", () => {
  const proxyUrl = currentStream?.stream_type === "direct" ? `${BRIDGE_ORIGIN}/stream-direct` : `${BRIDGE_ORIGIN}/stream.m3u8`;
  openUrl(currentStream?.stream_url ? proxyUrl : "");
});
els.direct.addEventListener("click", () => openUrl(currentStream?.stream_url));

refresh();
