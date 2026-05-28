"""M-Stream Bridge proxy for non-DRM streams."""

from __future__ import annotations

import datetime as _dt
import http.client
import http.server
import json
import os
import re
import socket
import sys
import threading
import urllib.parse
import urllib.request
from typing import Any
from urllib.error import HTTPError, URLError


urllib.request.install_opener(
    urllib.request.build_opener(urllib.request.ProxyHandler({}))
)

HOST = os.environ.get("BRIDGE_HOST", "localhost")
PORT = int(os.environ.get("BRIDGE_PORT", "7000"))
MAX_BODY_BYTES = 256 * 1024
MAX_HEADER_VALUE_LEN = 4096
LOG_PREFIX = "[BRIDGE]"

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

FORWARD_HEADER_ALLOWLIST = {
    "accept",
    "accept-encoding",
    "accept-language",
    "authorization",
    "cache-control",
    "cookie",
    "dnt",
    "origin",
    "pragma",
    "range",
    "referer",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "user-agent",
}

current_stream: dict[str, Any] = {
    "stream_url": "",
    "stream_type": "hls",
    "m3u8_url": "",
    "episode": None,
    "season": None,
    "detected_episode": None,
    "referer": "",
    "cookie": "",
    "user_agent": "",
    "origin": "",
    "request_headers": {},
    "url_header_map": {},
    "hls_master_url": "",
    "subtitle_url": "",
    "subtitle_filename": "",
    "title": "Untitled Stream",
    "title_candidates": [],
    "updated_at": None,
    "content_type": "",
}

_srt_store = {"content": "", "filename": "subtitle.srt"}
_STATE_LOCK = threading.RLock()


class _NullTextWriter:
    encoding = "utf-8"

    def write(self, value: str) -> int:
        return len(value or "")

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        return False


def _ensure_console_safe_stdio() -> None:
    if sys.stdout is None:
        sys.stdout = _NullTextWriter()  # type: ignore[assignment]
    if sys.stderr is None:
        sys.stderr = _NullTextWriter()  # type: ignore[assignment]


def _utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def _bridge_url() -> str:
    return f"http://{HOST}:{PORT}"


def _normalize_url(raw_url: Any, base_url: str = "") -> str:
    text = str(raw_url or "").strip()
    if not text:
        return ""
    if base_url:
        try:
            text = urllib.parse.urljoin(base_url, text)
        except Exception:
            pass
    try:
        parsed = urllib.parse.urlparse(text)
    except Exception:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return urllib.parse.urlunparse(parsed)


def _normalize_header_key(raw_url: Any) -> str:
    url = _normalize_url(raw_url)
    if not url:
        return ""
    parsed = urllib.parse.urlparse(url)
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))


def _guess_content_type(url: str) -> str:
    path = urllib.parse.urlparse(url).path.lower()
    if path.endswith(".m3u8") or ".m3u8" in path:
        return "application/vnd.apple.mpegurl"
    if path.endswith(".ts"):
        return "video/mp2t"
    if path.endswith(".m4s"):
        return "video/iso.segment"
    if path.endswith(".mp4") or ".mp4" in path:
        return "video/mp4"
    if path.endswith(".webm"):
        return "video/webm"
    if path.endswith(".srt"):
        return "application/x-subrip; charset=utf-8"
    if path.endswith(".vtt"):
        return "text/vtt; charset=utf-8"
    return "application/octet-stream"


def _infer_stream_type(url: str, explicit_type: Any = "") -> str:
    explicit = str(explicit_type or "").strip().lower()
    if explicit in {"hls", "direct"}:
        return explicit
    lowered = str(url or "").lower()
    if ".m3u8" in lowered:
        return "hls"
    if re.search(r"\.(mp4|webm|mkv|mov|m4v)(?:\?|$)", lowered):
        return "direct"
    return "hls"


def _sanitize_headers(raw_headers: Any) -> dict[str, str]:
    if not isinstance(raw_headers, dict):
        return {}
    headers: dict[str, str] = {}
    for name, value in raw_headers.items():
        key = str(name or "").strip().lower()
        if key not in FORWARD_HEADER_ALLOWLIST:
            continue
        text = str(value or "").strip()
        if not text:
            continue
        headers[key] = text[:MAX_HEADER_VALUE_LEN]
    return headers


def _merge_header_map(raw_map: Any) -> dict[str, dict[str, str]]:
    if not isinstance(raw_map, dict):
        return {}
    out: dict[str, dict[str, str]] = {}
    for raw_key, raw_headers in raw_map.items():
        key = str(raw_key or "").strip()
        if not key:
            continue
        headers = _sanitize_headers(raw_headers)
        if headers:
            out[key[:2048]] = headers
    return out


def _headers_for_url(target_url: str) -> dict[str, str]:
    with _STATE_LOCK:
        base_headers = dict(current_stream.get("request_headers") or {})
        header_map = dict(current_stream.get("url_header_map") or {})
        referer = str(current_stream.get("referer") or "")
        origin = str(current_stream.get("origin") or "")
        user_agent = str(current_stream.get("user_agent") or "")
        cookie = str(current_stream.get("cookie") or "")

    headers = _sanitize_headers(base_headers)
    for key in (target_url, _normalize_header_key(target_url)):
        mapped = header_map.get(key)
        if isinstance(mapped, dict):
            headers.update(_sanitize_headers(mapped))

    if referer and "referer" not in headers:
        headers["referer"] = referer
    if origin and "origin" not in headers:
        headers["origin"] = origin
    if user_agent and "user-agent" not in headers:
        headers["user-agent"] = user_agent
    if cookie and "cookie" not in headers:
        headers["cookie"] = cookie
    if "user-agent" not in headers:
        headers["user-agent"] = "Mozilla/5.0"
    return headers


def _make_request(url: str, extra_headers: dict[str, str] | None = None) -> urllib.request.Request:
    headers = _headers_for_url(url)
    if extra_headers:
        headers.update(extra_headers)
    return urllib.request.Request(url, headers=headers, method="GET")


def _json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class QuietThreadingHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        exc_type, exc, _tb = sys.exc_info()
        if exc_type in {ConnectionResetError, BrokenPipeError, ConnectionAbortedError}:
            return
        print(f"{LOG_PREFIX} request error from {client_address}: {exc}")


class BridgeProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        return

    def _send_cors_headers(self) -> None:
        origin = self.headers.get("Origin") or "*"
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges,Content-Type")

    def _send_json(self, status_code: int, payload: Any) -> None:
        body = _json_bytes(payload)
        self.send_response(status_code)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict[str, Any]:
        raw_length = self.headers.get("Content-Length") or "0"
        try:
            length = min(int(raw_length), MAX_BODY_BYTES)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        if not raw:
            return {}
        data = json.loads(raw.decode("utf-8", errors="replace"))
        return data if isinstance(data, dict) else {}

    def _stream_response(self, upstream_resp, fallback_content_type: str) -> None:
        status_code = getattr(upstream_resp, "status", 200)
        self.send_response(status_code)
        self._send_cors_headers()

        sent_content_type = False
        for header_name, header_value in upstream_resp.headers.items():
            name = str(header_name or "").lower()
            if not name or name in HOP_BY_HOP_HEADERS:
                continue
            if name == "content-type":
                sent_content_type = True
            self.send_header(header_name, header_value)

        if not sent_content_type:
            self.send_header("Content-Type", fallback_content_type)
        self.end_headers()

        while True:
            chunk = upstream_resp.read(256 * 1024)
            if not chunk:
                break
            self.wfile.write(chunk)

    def _rewrite_uri(self, line: str, base_url: str) -> str:
        def replace(match: re.Match[str]) -> str:
            quote = match.group(1)
            raw = match.group(2)
            absolute = _normalize_url(raw, base_url)
            if not absolute:
                return match.group(0)
            encoded = urllib.parse.quote(absolute, safe="")
            return f'URI={quote}http://{HOST}:{PORT}/proxy-segment?url={encoded}{quote}'

        return re.sub(r'URI=(["\'])(.*?)\1', replace, line)

    def _rewrite_m3u8(self, content: str, base_url: str) -> str:
        out: list[str] = []
        for raw_line in content.splitlines():
            line = raw_line.strip()
            if not line:
                out.append(raw_line)
                continue
            if line.startswith("#"):
                out.append(self._rewrite_uri(raw_line, base_url))
                continue
            absolute = _normalize_url(line, base_url)
            if absolute:
                encoded = urllib.parse.quote(absolute, safe="")
                out.append(f"http://{HOST}:{PORT}/proxy-segment?url={encoded}")
            else:
                out.append(raw_line)
        return "\n".join(out) + "\n"

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/":
            self._send_json(200, {
                "status": "ok",
                "service": "bridge_proxy",
                "version": "vdev",
            })
            return
        if path == "/health":
            self._send_json(200, {"status": "ok", "service": "bridge_proxy"})
            return
        if path == "/api/current-stream":
            self._handle_current_stream()
            return
        if path == "/stream.m3u8":
            self._handle_stream_proxy()
            return
        if path == "/stream-direct":
            self._handle_direct_stream_proxy()
            return
        if path == "/proxy-segment":
            self._handle_segment_proxy(qs)
            return
        if path == "/proxy-subtitle":
            self._handle_subtitle_proxy()
            return
        if path == "/proxy-subtitle-srt":
            self._handle_proxy_subtitle_srt()
            return

        self._send_json(404, {"status": "error", "message": "Not found"})

    def do_POST(self):
        try:
            if self.path == "/set-stream":
                self._handle_set_stream()
                return
            if self.path == "/capture-request":
                self._handle_capture_request()
                return
            if self.path == "/capture-event":
                self._handle_capture_request()
                return
            if self.path == "/set-subtitle":
                self._handle_set_subtitle()
                return
            self._send_json(404, {"status": "error", "message": "Not found"})
        except json.JSONDecodeError:
            self._send_json(400, {"status": "error", "message": "Invalid JSON"})
        except Exception as exc:
            print(f"{LOG_PREFIX} POST error: {exc}")
            self._send_json(500, {"status": "error", "message": "Internal error"})

    def _handle_current_stream(self):
        with _STATE_LOCK:
            snapshot = dict(current_stream)
            snapshot["request_headers"] = dict(current_stream.get("request_headers") or {})
            snapshot["url_header_map"] = dict(current_stream.get("url_header_map") or {})
        stream_type = _infer_stream_type(snapshot.get("stream_url") or "", snapshot.get("stream_type") or "")
        snapshot["stream_type"] = stream_type
        snapshot["proxy_url"] = f"http://{HOST}:{PORT}/stream-direct" if stream_type == "direct" else f"http://{HOST}:{PORT}/stream.m3u8"
        snapshot["proxy_subtitle_url"] = f"http://{HOST}:{PORT}/proxy-subtitle"
        snapshot["proxy_subtitle_srt_url"] = f"http://{HOST}:{PORT}/proxy-subtitle-srt"
        self._send_json(200, {"status": "ok", "stream": snapshot, **snapshot})

    def _handle_capture_request(self):
        data = self._read_json_body()
        url = _normalize_url(data.get("url") or "")
        headers = _sanitize_headers(data.get("request_headers") or {})
        key = str(data.get("url_key") or "").strip() or _normalize_header_key(url)
        if url and headers:
            with _STATE_LOCK:
                header_map = dict(current_stream.get("url_header_map") or {})
                header_map[url] = headers
                if key:
                    header_map[key] = headers
                current_stream["url_header_map"] = header_map
                current_stream["updated_at"] = _utc_now()
        self._send_json(200, {"status": "ok"})

    def _handle_set_stream(self):
        data = self._read_json_body()
        stream_url = _normalize_url(data.get("stream_url") or data.get("m3u8_url") or "")
        if not stream_url:
            self._send_json(400, {"status": "error", "message": "Missing stream_url"})
            return

        request_headers = _sanitize_headers(data.get("request_headers") or {})
        header_map = _merge_header_map(data.get("url_header_map") or {})
        if request_headers:
            header_map.setdefault(stream_url, request_headers)
            header_map.setdefault(_normalize_header_key(stream_url), request_headers)

        stream_type = _infer_stream_type(stream_url, data.get("stream_type") or "")
        with _STATE_LOCK:
            current_stream.update({
                "stream_url": stream_url,
                "stream_type": stream_type,
                "m3u8_url": stream_url if stream_type == "hls" else "",
                "hls_master_url": data.get("hls_master_url") or (stream_url if stream_type == "hls" else ""),
                "subtitle_url": _normalize_url(data.get("subtitle_url") or "", data.get("referer") or ""),
                "episode": data.get("episode"),
                "season": data.get("season"),
                "detected_episode": data.get("detected_episode"),
                "referer": str(data.get("referer") or ""),
                "origin": str(data.get("origin") or ""),
                "cookie": str(data.get("cookie") or request_headers.get("cookie") or ""),
                "user_agent": str(data.get("user_agent") or request_headers.get("user-agent") or ""),
                "request_headers": request_headers,
                "url_header_map": header_map,
                "title": str(data.get("title") or "Captured by Bridge Extension"),
                "title_candidates": data.get("title_candidates") if isinstance(data.get("title_candidates"), list) else [],
                "content_type": _guess_content_type(stream_url),
                "updated_at": _utc_now(),
            })

        print(f"{LOG_PREFIX} set stream {stream_type}: {stream_url[:140]}")
        self._send_json(200, {"status": "ok", "stream_type": stream_type})

    def _handle_set_subtitle(self):
        data = self._read_json_body()
        srt_content = str(data.get("srt_content") or data.get("content") or "")
        subtitle_url = _normalize_url(data.get("subtitle_url") or "")
        filename = str(data.get("filename") or "subtitle.srt").strip() or "subtitle.srt"

        with _STATE_LOCK:
            if srt_content:
                _srt_store["content"] = srt_content
                _srt_store["filename"] = filename
                current_stream["subtitle_url"] = f"http://{HOST}:{PORT}/proxy-subtitle-srt"
            elif subtitle_url:
                current_stream["subtitle_url"] = subtitle_url
            current_stream["subtitle_filename"] = filename
            current_stream["updated_at"] = _utc_now()

        self._send_json(200, {"status": "ok", "filename": filename})

    def _handle_stream_proxy(self):
        with _STATE_LOCK:
            target_url = str(current_stream.get("hls_master_url") or current_stream.get("m3u8_url") or current_stream.get("stream_url") or "")
        target_url = _normalize_url(target_url)
        if not target_url:
            self._send_json(404, {"status": "error", "message": "No active HLS stream"})
            return
        try:
            with urllib.request.urlopen(_make_request(target_url), timeout=25) as resp:
                raw = resp.read()
            text = raw.decode("utf-8", errors="replace")
            body = self._rewrite_m3u8(text, target_url).encode("utf-8")
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except HTTPError as exc:
            self._send_json(exc.code, {"status": "error", "message": f"Upstream HTTP {exc.code}"})
        except Exception as exc:
            print(f"{LOG_PREFIX} stream proxy error: {exc}")
            self._send_json(502, {"status": "error", "message": "Failed to fetch HLS playlist"})

    def _handle_direct_stream_proxy(self):
        with _STATE_LOCK:
            target_url = str(current_stream.get("stream_url") or "")
        target_url = _normalize_url(target_url)
        if not target_url:
            self._send_json(404, {"status": "error", "message": "No active direct stream"})
            return
        self._proxy_binary(target_url, _guess_content_type(target_url))

    def _handle_segment_proxy(self, qs: dict[str, list[str]]):
        target_url = _normalize_url((qs.get("url") or [""])[0])
        if not target_url:
            self._send_json(400, {"status": "error", "message": "Missing url"})
            return
        self._proxy_binary(target_url, _guess_content_type(target_url))

    def _handle_subtitle_proxy(self):
        with _STATE_LOCK:
            subtitle_url = str(current_stream.get("subtitle_url") or "")
        subtitle_url = _normalize_url(subtitle_url)
        if not subtitle_url:
            self._send_json(404, {"status": "error", "message": "No subtitle"})
            return
        if subtitle_url.endswith("/proxy-subtitle-srt"):
            self._handle_proxy_subtitle_srt()
            return
        self._proxy_binary(subtitle_url, _guess_content_type(subtitle_url))

    def _handle_proxy_subtitle_srt(self):
        with _STATE_LOCK:
            content = _srt_store.get("content") or ""
            filename = _srt_store.get("filename") or "subtitle.srt"
        if not content:
            self._send_json(404, {"status": "error", "message": "No SRT subtitle"})
            return
        body = content.encode("utf-8")
        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/x-subrip; charset=utf-8")
        self.send_header("Content-Disposition", f'inline; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _proxy_binary(self, target_url: str, fallback_content_type: str):
        extra_headers: dict[str, str] = {}
        range_header = self.headers.get("Range")
        if range_header:
            extra_headers["range"] = range_header
        try:
            with urllib.request.urlopen(_make_request(target_url, extra_headers), timeout=35) as resp:
                self._stream_response(resp, fallback_content_type)
        except HTTPError as exc:
            self._send_json(exc.code, {"status": "error", "message": f"Upstream HTTP {exc.code}"})
        except (URLError, http.client.IncompleteRead, TimeoutError, socket.timeout) as exc:
            print(f"{LOG_PREFIX} proxy failed: {exc}")
            self._send_json(502, {"status": "error", "message": "Failed to fetch upstream media"})
        except Exception as exc:
            print(f"{LOG_PREFIX} proxy error: {exc}")
            self._send_json(500, {"status": "error", "message": "Internal error"})


def _bridge_health_ok(timeout: float = 0.5) -> bool:
    try:
        with urllib.request.urlopen(f"{_bridge_url()}/health", timeout=timeout) as resp:
            raw = resp.read(4096)
        payload = json.loads(raw.decode("utf-8", errors="replace") or "{}")
        return payload.get("status") == "ok" and payload.get("service") == "bridge_proxy"
    except Exception:
        return False


def run_server() -> None:
    _ensure_console_safe_stdio()
    bridge_url = _bridge_url()

    if _bridge_health_ok():
        print(f"{LOG_PREFIX} already running: {bridge_url}")
        return

    try:
        server = QuietThreadingHTTPServer((HOST, PORT), BridgeProxyHandler)
    except OSError as exc:
        print(f"{LOG_PREFIX} could not start on {bridge_url}: {exc}")
        return

    print()
    print("=" * 72)
    print("M-Stream Bridge")
    print("=" * 72)
    print(f"Bridge API : {bridge_url}")
    print("Endpoint   :")
    print("- GET  /")
    print("- GET  /health")
    print("- POST /set-stream")
    print("- POST /capture-request")
    print("- POST /capture-event")
    print("- GET  /api/current-stream")
    print("- GET  /stream.m3u8")
    print("- GET  /stream-direct")
    print("- GET  /proxy-segment?url=<encoded>")
    print("- GET  /proxy-subtitle")
    print("- GET  /proxy-subtitle-srt")
    print("- POST /set-subtitle")
    print("=" * 72)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(f"\n{LOG_PREFIX} server stopped.")
    finally:
        server.shutdown()


if __name__ == "__main__":
    run_server()
