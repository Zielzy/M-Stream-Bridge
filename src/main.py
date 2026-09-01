# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     __VERSION__
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
"""
Universal bridge proxy for non-DRM media streams (M-Stream Bridge Server).

Core Server Architecture & Workflow:
1. HTTP Proxy Server:
   - Runs on port 7000 (127.0.0.1:7000) using a multi-threaded server.
   - Provides API endpoints to receive streams from browser extension (`/set-stream`),
     storing active stream metadata (URL, referer, cookies, user-agent, season, episode, title).
   - Serves local admin dashboard UI for managing settings and stream status.

2. HLS Playlist & Segment Rewriter/Proxy:
   - HLS streams (.m3u8) from remote CDNs are proxied via localhost (`/stream.m3u8` or `/proxy-segment`).
   - Playlist parser downloads the original `.m3u8`, parses it, and rewrites
     each segment URI (.ts / .m4s) or sub-playlist to route through the local server.
   - Allows video players (like hls.js in Migaku Player) to play CDN media requiring
     specific headers/cookies/referer directly from localhost.

3. Subtitle Engine (Jimaku & Subdl):
   - Background worker threads asynchronously monitor active stream metadata.
   - Searches Jimaku API (Japanese anime subtitles) and Subdl API (multi-language general media).
   - Automatically downloads matching subtitles and serves them to Migaku Player via `/proxy-subtitle-srt`.

4. Cloudflare Bypass (FlareSolverr / Headless Integration):
   - Handles Cloudflare Turnstile protected streams when upstream CDNs require active clearance.
"""

from __future__ import annotations

import datetime
import hashlib
import http.server
import json
import logging
import os
from pathlib import Path
import re
import socket
import sys
import threading
import time
from typing import Any
import urllib.parse
import urllib.request
from urllib.error import HTTPError, URLError
import webbrowser

from core.capture_engine import (
    CaptureEngineMixin,
    _clear_manual_pin_if_stream_changed_unlocked,
    _is_bridge_local_url,
)
from core.cloudflare import (
    _CF_COOKIES,
    _set_cookie_header,
    _set_ua_header,
    _solve_cloudflare_turnstile,
)
from core.config import (
    ensure_config_exists,
    get_config_path,
    load_jimaku_api_key,
    load_subdl_api_key,
    load_subdl_languages,
    load_tmdb_api_key,
)
from core.hls_proxy import HlsProxyMixin
from core.state import (
    CAPTURE_TAB_META_TTL_SEC,
    HOST,
    LOG_BUFFER,
    LOG_LEVEL,
    LOG_LOCK,
    LOG_PREFIX,
    LOG_TOTAL_COUNT,
    MAX_BODY_BYTES,
    MAX_CAPTURE_CANDIDATES,
    MAX_CAPTURE_TAB_META,
    MAX_LOG_ENTRIES,
    MAX_MANUAL_SUBTITLE_CANDIDATES,
    MAX_URL_HEADER_MAP,
    MAX_URL_HEADER_MAP_PER_HOST,
    PORT,
    SEGMENT_521_RETRY_ATTEMPTS,
    SEGMENT_521_RETRY_DELAY_SEC,
    SEGMENT_TRANSIENT_RETRY_ATTEMPTS,
    SEGMENT_TRANSIENT_RETRY_DELAY_SEC,
    STATE_LOCK,
    capture_active_state,
    capture_candidates,
    capture_tab_meta,
    current_stream,
    manual_subtitle_candidates,
    manual_subtitle_pin,
    srt_store,
)
from subtitle_providers.jimaku import (
    JimakuBridge,
    _is_subtitle_like_url,
    _stream_key,
)
from subtitle_providers.subdl import SubdlProvider
from utils.audio_extractor import (
    cancel_extraction,
    get_audio_temp_path,
    get_extraction_status,
    start_extraction_async,
)
from utils.ffmpeg_downloader import (
    download_ffmpeg_async,
    get_download_status,
)
from utils.title_parser import clean_media_title


# =============================================================================
# Standard Output & Networking Initialization
# =============================================================================

if sys.stdout:
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass
if sys.stderr:
    try:
        sys.stderr.reconfigure(errors="replace")
    except Exception:
        pass

urllib.request.install_opener(
    urllib.request.build_opener(urllib.request.ProxyHandler({}))
)

try:
    import requests as _requests

    REQUESTS_AVAILABLE = True
except ImportError:
    _requests = None
    REQUESTS_AVAILABLE = False

try:
    from curl_cffi import requests as _cffi_requests

    CURL_CFFI_AVAILABLE = True
except ImportError:
    _cffi_requests = None
    CURL_CFFI_AVAILABLE = False

# Concurrency limit for segment upstream fetches to avoid CDN throttling
_SEGMENT_PROXY_SEMAPHORE = threading.Semaphore(3)


# =============================================================================
# Console & Asset Path Utilities
# =============================================================================

class _NullTextWriter:
    """Small stdout/stderr fallback used by windowed PyInstaller builds."""

    encoding = "utf-8"

    def write(self, value: str) -> int:
        return len(value or "")

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        return False


def _ensure_console_safe_stdio() -> None:
    """PyInstaller --windowed starts with sys.stdout/sys.stderr set to None."""
    if sys.stdout is None:
        sys.stdout = _NullTextWriter()  # type: ignore[assignment]
    if sys.stderr is None:
        sys.stderr = _NullTextWriter()  # type: ignore[assignment]


def _dashboard_url() -> str:
    return f"http://{HOST}:{PORT}"


def _health_url() -> str:
    return f"http://{HOST}:{PORT}/health"


def _open_dashboard() -> None:
    try:
        webbrowser.open(_dashboard_url())
    except Exception as exc:
        print(f"[BRIDGE] dashboard open failed: {exc}")


def _bridge_health_ok(timeout: float = 0.75) -> bool:
    try:
        with urllib.request.urlopen(_health_url(), timeout=timeout) as resp:
            status = getattr(resp, "status", 200)
            if status < 200 or status >= 300:
                return False
            raw = resp.read(4096)
        payload = json.loads(raw.decode("utf-8", errors="replace") or "{}")
        return payload.get("status") == "ok" and payload.get("service") == "bridge_proxy"
    except Exception:
        return False


def _show_startup_error(message: str) -> None:
    title = "M-Stream Bridge"
    if os.name == "nt":
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(None, message, title, 0x10)
            return
        except Exception:
            pass
    print(f"[BRIDGE] {message}")


def _runtime_dir() -> Path:
    """Return the folder where user-editable release assets live.

    Determines the folder where configuration files and external assets are stored/read.
    """
    is_nuitka = False
    try:
        _ = __compiled__
        is_nuitka = True
    except NameError:
        pass

    # If running as compiled executable (PyInstaller, Nuitka, or external executable)
    if getattr(sys, "frozen", False) or is_nuitka or sys.argv[0].lower().endswith(".exe"):
        if is_nuitka:
            try:
                return Path(__compiled__.containing_dir).resolve()
            except Exception:
                pass
        return Path(sys.argv[0]).resolve().parent

    # Standard development mode: scan candidate paths to find assets
    candidates = [Path(__file__).resolve().parent, Path.cwd()]
    for candidate in candidates:
        if (candidate / "dashboard.html").exists():
            return candidate
    return candidates[0]


def _bundled_asset_path(name: str) -> Path | None:
    """Return a PyInstaller or Nuitka bundled asset path when available.

    Locates bundled assets inside executable packages at runtime.
    """
    bundle_dir = getattr(sys, "_MEIPASS", None)
    if bundle_dir:
        path = Path(bundle_dir) / name
        if path.exists():
            return path

    is_nuitka = False
    try:
        _ = __compiled__
        is_nuitka = True
    except NameError:
        pass

    if getattr(sys, "frozen", False) or is_nuitka:
        try:
            nuitka_dir = Path(__file__).resolve().parent
            path = nuitka_dir / name
            if path.exists():
                return path
        except Exception:
            pass

    return None


def _dashboard_html_path() -> Path:
    bundled = _bundled_asset_path("dashboard.html")
    if bundled is not None:
        return bundled
    return _runtime_dir() / "dashboard.html"


def _mstream_png_path() -> Path:
    bundled = _bundled_asset_path("assets/mstream.png")
    if bundled is not None:
        return bundled
    return _runtime_dir() / "assets" / "mstream.png"


# =============================================================================
# In-Memory Circular Logging Engine
# =============================================================================

def _push_log(level: str, message: str) -> None:
    """Push one log entry into the circular buffer."""
    global LOG_TOTAL_COUNT

    with LOG_LOCK:
        LOG_TOTAL_COUNT += 1
        entry = {
            "id": LOG_TOTAL_COUNT,
            "ts": datetime.datetime.now().strftime("%H:%M:%S"),
            "level": level,
            "msg": message,
        }
        LOG_BUFFER.append(entry)
        if len(LOG_BUFFER) > MAX_LOG_ENTRIES:
            del LOG_BUFFER[0]


class _BufferLogHandler(logging.Handler):
    """Intercepts LOGGER (MStreamBridge) output into LOG_BUFFER."""

    def emit(self, record: logging.LogRecord) -> None:
        level = record.levelname
        msg = self.format(record)
        _push_log(level, msg)
        print(msg)


LOGGER = logging.getLogger("mstream_bridge")


def _setup_bridge_logging() -> None:
    logger = logging.getLogger("mstream_bridge")
    logger.setLevel(logging.INFO)
    if logger.handlers:
        return
    buf_handler = _BufferLogHandler()
    buf_handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(buf_handler)


# =============================================================================
# Background Worker Initialization
# =============================================================================

def _start_jimaku_worker() -> object | None:
    if not REQUESTS_AVAILABLE:
        print("[JIMAKU] worker disabled: requests is not installed")
        print("[JIMAKU] install with: pip install requests")
        return None

    api_key = load_jimaku_api_key()
    if not api_key:
        print("[JIMAKU] worker disabled: API key is not available.")
        return None

    _setup_bridge_logging()
    try:
        worker = JimakuBridge(
            api_key=api_key,
            proxy_base_url=f"http://{HOST}:{PORT}",
            poll_interval_sec=max(1, int(os.environ.get("JIMAKU_POLL_INTERVAL", "2"))),
        )
        worker.start()
        return worker
    except Exception as exc:
        print(f"[JIMAKU] worker failed to start: {exc}")
        return None


# =============================================================================
# Response Adapter for Unified HTTP Streaming
# =============================================================================

class RequestsResponseAdapter:
    """Wraps a buffered or streamed HTTP response into a urllib-compatible interface."""

    def __init__(self, resp: Any, stream: bool = False) -> None:
        self._resp = resp
        self._stream = stream
        if not stream:
            self._data = resp.content
            self._pos = 0
        else:
            self._iter = resp.iter_content(chunk_size=64 * 1024)
        self.headers = resp.headers
        self.status = resp.status_code
        self.code = resp.status_code
        self.reason = getattr(resp, "reason", "") or ""

    def read(self, amt: int | None = None) -> bytes:
        if not self._stream:
            if amt is None:
                chunk = self._data[self._pos:]
                self._pos = len(self._data)
                return chunk
            chunk = self._data[self._pos:self._pos + amt]
            self._pos += len(chunk)
            return chunk
        else:
            try:
                return next(self._iter)
            except StopIteration:
                return b""

    def __enter__(self) -> RequestsResponseAdapter:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def close(self) -> None:
        try:
            self._resp.close()
        except Exception:
            pass


# =============================================================================
# Main Bridge HTTP Request Handler
# =============================================================================

class BridgeProxyHandler(http.server.BaseHTTPRequestHandler, CaptureEngineMixin, HlsProxyMixin):
    _session = None
    _cffi_session = None
    _session_lock = threading.Lock()

    HOP_BY_HOP_HEADERS = {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
        "accept-encoding",
        "content-length",
    }
    CLIENT_REPLAY_HEADERS = {
        "range",
        "if-range",
        "accept",
        "accept-encoding",
        "accept-language",
    }
    LOG_PRIORITY = {
        "DEBUG": 10,
        "INFO": 20,
        "WARN": 30,
        "ERROR": 40,
    }
    THROTTLED_LOG_STATE: dict[str, float] = {}

    # -------------------------------------------------------------------------
    # Logging & Console Output
    # -------------------------------------------------------------------------

    def log_message(self, _format: str, *_args: Any) -> None:
        # Keep the console clean; request logs are handled explicitly.
        return

    def _log(self, level: str, message: str) -> None:
        current_priority = self.LOG_PRIORITY.get(LOG_LEVEL, 20)
        incoming_priority = self.LOG_PRIORITY.get((level or "INFO").upper(), 20)
        if incoming_priority < current_priority:
            return
        full_msg = f"{LOG_PREFIX} {message}"
        print(full_msg)
        _push_log((level or "INFO").upper(), full_msg)

    def _log_throttled(self, key: str, level: str, message: str, interval_seconds: float = 10) -> None:
        now = time.time()
        prev = self.THROTTLED_LOG_STATE.get(key, 0)
        if now - prev < interval_seconds:
            return
        self.THROTTLED_LOG_STATE[key] = now
        self._log(level, message)

    # -------------------------------------------------------------------------
    # Stream State & Identity Snapshots
    # -------------------------------------------------------------------------

    def _snapshot_stream(self, include_replay_map: bool = True) -> dict[str, Any]:
        """Copy stream state, optionally excluding the large URL replay map."""
        with STATE_LOCK:
            snapshot = dict(current_stream)
            snapshot["request_headers"] = dict(current_stream.get("request_headers") or {})
            if include_replay_map:
                snapshot["url_header_map"] = dict(current_stream.get("url_header_map") or {})
            else:
                snapshot.pop("url_header_map", None)
            return snapshot

    def _public_stream_snapshot(self) -> dict[str, Any]:
        """Return UI-safe stream state without replay-only headers."""
        snapshot = self._snapshot_stream(include_replay_map=False)
        raw_title = snapshot.get("title") or snapshot.get("display_title") or ""
        clean_title = clean_media_title(raw_title)
        if not clean_title or clean_title == raw_title:
            clean_title = clean_media_title(snapshot.get("display_title") or "")
        snapshot["clean_title"] = clean_title
        for key in (
            "cookie",
            "origin",
            "referer",
            "request_headers",
            "url_header_map",
            "user_agent",
            "tmdb",
        ):
            snapshot.pop(key, None)

        tmdb_data = current_stream.get("tmdb")
        if tmdb_data:
            poster = tmdb_data.get("poster")
            backdrop = tmdb_data.get("backdrop")
            if poster:
                snapshot["cover_url"] = f"http://{HOST}:{PORT}/api/image?url=https://image.tmdb.org/t/p/w500{poster}"
            if backdrop:
                snapshot["banner_url"] = f"http://{HOST}:{PORT}/api/image?url=https://image.tmdb.org/t/p/w1280{backdrop}"

        return snapshot

    def _trigger_segment_resync(self, reason: str, target_url: str = "") -> None:
        with STATE_LOCK:
            master_url = self._normalize_url(current_stream.get("hls_master_url") or "")
            stream_url = self._normalize_url(current_stream.get("stream_url") or "")
            chosen_url = master_url or stream_url
            if chosen_url:
                current_stream["stream_url"] = chosen_url
                current_stream["m3u8_url"] = chosen_url
                current_stream["stream_type"] = self._infer_stream_type(chosen_url, current_stream.get("stream_type") or "")
            current_stream["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self._log(
            "WARN",
            f"stream auto-resync triggered | reason={reason} | target={str(target_url)[:120]}",
        )

    # -------------------------------------------------------------------------
    # HTTP & CORS Utilities
    # -------------------------------------------------------------------------

    def _send_json(self, status_code: int, payload: Any, allow_cors: bool = True) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status_code)
            if allow_cors:
                self._send_cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            return

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Expose-Headers", "*")

    def _mask_secret(self, value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        if len(text) <= 8:
            return "*" * len(text)
        return f"{text[:4]}...{text[-4:]}"

    def _config_origin_allowed(self) -> bool:
        origin = (self.headers.get("Origin") or "").strip()
        if not origin:
            return True
        try:
            parsed = urllib.parse.urlparse(origin)
        except Exception:
            return False
        return (
            parsed.scheme == "http"
            and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
            and (parsed.port or 80) == PORT
        )

    def _reject_config_origin_if_needed(self) -> bool:
        if self._config_origin_allowed():
            return False
        self._send_json(403, {
            "status": "error",
            "message": "Forbidden origin for config endpoint",
        }, allow_cors=False)
        return True

    def _clean_url(self, value: str | None) -> str:
        return (value or "").strip().strip(' \t\r\n"\'`').rstrip(")}],.;:")

    def _is_valid_http_url(self, url: str) -> bool:
        parsed = urllib.parse.urlparse(url)
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)

    # -------------------------------------------------------------------------
    # Stream URL & Content-Type Analysis
    # -------------------------------------------------------------------------

    def _guess_content_type(self, url: str) -> str:
        lowered = (url or "").lower()
        if ".mpd" in lowered:
            return "application/dash+xml"
        if ".m3u8" in lowered:
            return "application/vnd.apple.mpegurl"
        if ".mp4" in lowered:
            return "video/mp4"
        if ".webm" in lowered:
            return "video/webm"
        if ".m4s" in lowered:
            return "video/iso.segment"
        if ".ts" in lowered:
            return "video/MP2T"
        if ".aac" in lowered:
            return "audio/aac"
        if ".mp3" in lowered:
            return "audio/mpeg"
        if ".m4a" in lowered:
            return "audio/mp4"
        if ".wav" in lowered:
            return "audio/wav"
        if ".ogg" in lowered:
            return "audio/ogg"
        if ".opus" in lowered:
            return "audio/ogg"
        if ".vtt" in lowered:
            return "text/vtt"
        if ".ass" in lowered:
            return "text/plain; charset=utf-8"
        return "application/octet-stream"

    def _is_probably_video_direct(self, url: str) -> bool:
        lowered = (url or "").lower()
        if not lowered:
            return False
        return (
            re.search(r"(^|[/_-])video([/_-]|\d|$)|/video/", lowered) is not None
            or re.search(r"(1080p|720p|480p|360p|itag=)", lowered) is not None
        )

    def _is_hls_master_url(self, url: str) -> bool:
        lowered = (url or "").lower()
        if ".m3u8" not in lowered:
            return False
        return re.search(r"(^|/)(master|index|playlist|manifest|.*-hls)[^/]*\.m3u8(?:[?#]|$)", lowered) is not None

    def _is_hls_variant_url(self, url: str) -> bool:
        lowered = (url or "").lower()
        if ".m3u8" not in lowered or self._is_hls_master_url(lowered):
            return False
        if re.search(r"(?:^|[/._-])(?:1080|720|480|360|2160|4k|[0-9]{5,})(?:p)?[/._-]?[^/]*\.m3u8(?:[?#]|$)", lowered):
            return True
        if re.search(r"(?:^|[/._-])(?:video|rendition|variant|stream|chunklist|audio)[/._-]?[^/]*\.m3u8(?:[?#]|$)", lowered):
            return True
        return False

    def _hls_session_key(self, url: str) -> str:
        normalized = self._normalize_url(url)
        if not normalized:
            return ""
        try:
            parsed = urllib.parse.urlparse(normalized)
            parts = [part for part in parsed.path.split("/") if part]
            if len(parts) <= 1:
                return f"{parsed.scheme}://{parsed.netloc}"
            return f"{parsed.scheme}://{parsed.netloc}/{'/'.join(parts[:-1])}"
        except Exception:
            return ""

    def _extract_long_hex_tokens(self, url: str) -> set[str]:
        if not url:
            return set()
        return set(re.findall(r"[a-f0-9]{16,}", url.lower()))

    def _same_hls_session(self, left_url: str, right_url: str) -> bool:
        left_key = self._hls_session_key(left_url)
        right_key = self._hls_session_key(right_url)
        if bool(left_key and right_key and left_key == right_key):
            return True

        # Fallback 1: check for shared long hex tokens
        left_tokens = self._extract_long_hex_tokens(left_url)
        right_tokens = self._extract_long_hex_tokens(right_url)
        if left_tokens and right_tokens and left_tokens.intersection(right_tokens):
            return True

        # Fallback 2: Ultracloud rotating Base64URL tokens
        left_b64 = set(re.findall(r"[A-Za-z0-9_~\-]{32,}", left_url))
        right_b64 = set(re.findall(r"[A-Za-z0-9_~\-]{32,}", right_url))
        if any(tok1[:32] == tok2[:32] for tok1 in left_b64 for tok2 in right_b64):
            return True

        return False

    def _trim_header_map(self, header_map: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(header_map, dict):
            return {}

        keys_reversed = list(header_map.keys())[::-1]
        host_counts: dict[str, int] = {}
        drop_keys = set()

        for key in keys_reversed:
            try:
                parsed = urllib.parse.urlparse(str(key))
                host = parsed.netloc or ""
            except Exception:
                host = ""
            host_counts[host] = host_counts.get(host, 0) + 1
            if host and host_counts[host] > MAX_URL_HEADER_MAP_PER_HOST:
                drop_keys.add(key)

        if drop_keys:
            for key in list(header_map.keys()):
                if key in drop_keys:
                    header_map.pop(key, None)

        while len(header_map) > MAX_URL_HEADER_MAP:
            oldest_key = next(iter(header_map.keys()), None)
            if oldest_key is None:
                break
            header_map.pop(oldest_key, None)

        return header_map

    def _infer_stream_type(self, url: str, explicit_type: str = "") -> str:
        explicit = (explicit_type or "").strip().lower()
        if explicit in {"hls", "direct"}:
            return explicit

        lowered = (url or "").lower()
        if ".m3u8" in lowered:
            return "hls"
        if re.search(r"/hls\d*/|/playlist/|/manifest/|/rendition/", lowered):
            return "hls"
        if "videoplayback" in lowered:
            return "direct"
        if any(ext in lowered for ext in [".mp4", ".webm", ".m4v", ".mov", ".mkv", ".m4s"]):
            return "direct"
        return "hls"

    def _read_json_body(self) -> dict[str, Any]:
        length_header = self.headers.get("Content-Length", "0")
        try:
            content_length = int(length_header)
        except ValueError:
            raise ValueError("Content-Length is invalid")

        if content_length <= 0:
            raise ValueError("Request body is empty")
        if content_length > MAX_BODY_BYTES:
            raise ValueError(f"Request body exceeds maximum allowed size ({MAX_BODY_BYTES} bytes)")

        raw = self.rfile.read(content_length)
        return json.loads(raw.decode("utf-8"))

    # -------------------------------------------------------------------------
    # Header Extraction & Sanitation
    # -------------------------------------------------------------------------

    def _sanitize_forward_headers(self, raw_headers: dict[str, Any]) -> dict[str, str]:
        cleaned: dict[str, str] = {}
        if not isinstance(raw_headers, dict):
            return cleaned

        for key, value in raw_headers.items():
            k = str(key or "").strip().lower()
            if not k or k in self.HOP_BY_HOP_HEADERS:
                continue
            v = str(value or "").strip()
            if not v:
                continue
            cleaned[k] = v
        return cleaned

    def _normalize_header_map_key(self, raw_url: str) -> str:
        normalized = self._normalize_url(raw_url)
        if not normalized:
            return ""
        try:
            parsed = urllib.parse.urlparse(normalized)
            if not parsed.scheme or not parsed.netloc:
                return ""
            return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
        except Exception:
            return ""

    def _sanitize_url_header_map(self, raw_map: dict[str, Any]) -> dict[str, dict[str, str]]:
        cleaned: dict[str, dict[str, str]] = {}
        if not isinstance(raw_map, dict):
            return cleaned
        for raw_key, raw_headers in raw_map.items():
            key = self._normalize_url(raw_key)
            normalized_key = self._normalize_header_map_key(raw_key)
            headers = self._sanitize_forward_headers(raw_headers)
            if not headers:
                continue
            if key:
                cleaned[key] = headers
            if normalized_key:
                cleaned[normalized_key] = headers
        return cleaned

    def _headers_for_key(self, key: str, header_map: dict[str, Any] | None = None) -> dict[str, str]:
        if header_map is None:
            with STATE_LOCK:
                header_map = dict(current_stream.get("url_header_map") or {})
        if not isinstance(header_map, dict):
            return {}
        val = header_map.get(key, {})
        return val if isinstance(val, dict) else {}

    def _find_hls_headers_for_url(self, target_url: str, stream_snapshot: dict[str, Any] | None = None) -> tuple[dict[str, str], str]:
        if stream_snapshot is None:
            stream_snapshot = self._snapshot_stream()
        header_map = stream_snapshot.get("url_header_map") or {}
        full_url = self._normalize_url(target_url)
        normalized = self._normalize_header_map_key(full_url)
        parsed = urllib.parse.urlparse(full_url) if full_url else None
        path = parsed.path if parsed else ""
        queryless = f"{parsed.scheme}://{parsed.netloc}{parsed.path}" if parsed else ""

        # 1) Exact full URL
        exact = self._sanitize_forward_headers(self._headers_for_key(full_url, header_map))
        if exact:
            return exact, "exact"

        # 2) No-query URL
        no_query = self._sanitize_forward_headers(self._headers_for_key(queryless, header_map))
        if no_query:
            return no_query, "no-query"

        # 3) Normalized key (origin + pathname)
        normalized_hit = self._sanitize_forward_headers(self._headers_for_key(normalized, header_map))
        if normalized_hit:
            return normalized_hit, "normalized"

        # 4) Parent path lookup (nearest path prefix)
        if parsed and path:
            best_headers: dict[str, str] = {}
            best_prefix_len = -1
            origin_prefix = f"{parsed.scheme}://{parsed.netloc}".lower()
            for key, headers in header_map.items():
                if not isinstance(headers, dict):
                    continue
                key_text = str(key)
                if not key_text.lower().startswith(origin_prefix):
                    continue
                suffix = key_text[len(origin_prefix):]
                if suffix and not suffix.startswith(("/", "?", "#")):
                    continue
                candidate_path = suffix.split("?", 1)[0].split("#", 1)[0]
                if not candidate_path:
                    continue
                if not path.startswith(candidate_path.rstrip("/") + "/") and path != candidate_path:
                    continue
                cleaned = self._sanitize_forward_headers(headers)
                if not cleaned:
                    continue
                prefix_len = len(candidate_path)
                if prefix_len > best_prefix_len:
                    best_prefix_len = prefix_len
                    best_headers = cleaned
            if best_headers:
                return best_headers, "parent"

        # 5) Fallback to master.m3u8 header if available
        master_url = self._normalize_url(stream_snapshot.get("hls_master_url") or "")
        if master_url:
            master_candidates = [
                master_url,
                self._normalize_header_map_key(master_url),
            ]
            for candidate in master_candidates:
                master_hit = self._sanitize_forward_headers(self._headers_for_key(candidate, header_map))
                if master_hit:
                    return master_hit, "master"

        return {}, "none"

    # -------------------------------------------------------------------------
    # Upstream HTTP Client & Cloudflare Bypass
    # -------------------------------------------------------------------------

    def _make_request(self, url: str, extra_headers: dict[str, str] | None = None) -> urllib.request.Request:
        stream_snapshot = self._snapshot_stream(include_replay_map=False)
        headers = {
            "User-Agent": stream_snapshot.get("user_agent") or "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept": "*/*",
        }
        if not extra_headers:
            referer = stream_snapshot.get("referer")
            cookie = (stream_snapshot.get("cookie") or "").strip()
            origin = (stream_snapshot.get("origin") or "").strip()
            if referer:
                headers["Referer"] = referer
                parsed_ref = urllib.parse.urlparse(referer)
                if parsed_ref.scheme and parsed_ref.netloc:
                    headers["Origin"] = f"{parsed_ref.scheme}://{parsed_ref.netloc}"
            elif origin:
                headers["Origin"] = origin
            if cookie:
                headers["Cookie"] = cookie
        if extra_headers:
            for key, value in extra_headers.items():
                if value:
                    headers[key] = value
        return urllib.request.Request(url, headers=headers)

    def _perform_urlopen(self, url: str, headers: dict[str, str], timeout: float, stream: bool = False, bypass_cffi: bool = False) -> Any:
        # Priority 1: curl_cffi with Chrome TLS impersonation (bypasses Cloudflare)
        if CURL_CFFI_AVAILABLE and not bypass_cffi:
            if BridgeProxyHandler._cffi_session is None:
                with BridgeProxyHandler._session_lock:
                    if BridgeProxyHandler._cffi_session is None:
                        BridgeProxyHandler._cffi_session = _cffi_requests.Session(impersonate="chrome")
            session = BridgeProxyHandler._cffi_session
            try:
                resp = session.get(url, headers=headers, timeout=timeout, allow_redirects=True, stream=stream)
            except Exception as exc:
                exc_str = str(exc).lower()
                if "timeout" in exc_str or "timed out" in exc_str:
                    raise socket.timeout("timed out") from exc
                raise URLError(str(exc)) from exc

            if resp.status_code >= 400:
                raise HTTPError(url, resp.status_code, getattr(resp, "reason", "") or "", resp.headers, None)

            return RequestsResponseAdapter(resp, stream=stream)

        # Priority 2: requests library
        if REQUESTS_AVAILABLE:
            if BridgeProxyHandler._session is None:
                with BridgeProxyHandler._session_lock:
                    if BridgeProxyHandler._session is None:
                        BridgeProxyHandler._session = _requests.Session()
            session = BridgeProxyHandler._session
            try:
                resp = session.get(url, headers=headers, timeout=timeout, stream=True)
            except _requests.exceptions.Timeout as exc:
                raise socket.timeout("timed out") from exc
            except _requests.exceptions.RequestException as exc:
                raise URLError(str(exc)) from exc

            if resp.status_code >= 400:
                raise HTTPError(url, resp.status_code, resp.reason, resp.headers, None)

            return RequestsResponseAdapter(resp, stream=stream)

        # Priority 3: stdlib urllib (no Cloudflare bypass)
        req = urllib.request.Request(url, headers=headers)
        return urllib.request.urlopen(req, timeout=timeout)

    def _urlopen(self, req: urllib.request.Request | str, timeout: float = 45, stream: bool = False) -> Any:
        if isinstance(req, str):
            url = req
            headers = {}
        else:
            url = req.full_url
            headers = {k: v for k, v in req.header_items()}

        domain = urllib.parse.urlparse(url).netloc

        # Inject cached Cloudflare clearance cookie and UA if available
        cf_data = _CF_COOKIES.get(domain)
        if cf_data and time.time() < cf_data.get("expires_at", 0):
            if cf_data.get("cookie"):
                _set_cookie_header(headers, cf_data["cookie"])
            if cf_data.get("user_agent"):
                _set_ua_header(headers, cf_data["user_agent"])

        try:
            return self._perform_urlopen(url, headers, timeout, stream=stream)
        except Exception as exc:
            is_cf_error = False
            if isinstance(exc, HTTPError) and exc.code in {403, 503}:
                is_cf_error = True
            elif isinstance(exc, (socket.timeout, TimeoutError)):
                is_cf_error = True
            elif "timed out" in str(exc).lower():
                is_cf_error = True

            if is_cf_error and "mewcdn.online" in domain:
                print(f"[BRIDGE] Upstream request failed ({exc}). Retrying after solving Cloudflare Turnstile...")
                solution = _solve_cloudflare_turnstile(url)
                if solution:
                    if solution.get("cookie"):
                        _set_cookie_header(headers, solution["cookie"])
                    if solution.get("user_agent"):
                        _set_ua_header(headers, solution["user_agent"])
                    try:
                        return self._perform_urlopen(url, headers, timeout, stream=stream)
                    except Exception as retry_exc:
                        raise retry_exc
            raise exc

    def _extract_client_replay_headers(self) -> dict[str, str]:
        raw = self._sanitize_forward_headers(dict(self.headers.items()))
        out: dict[str, str] = {}
        for key, value in raw.items():
            if key in self.CLIENT_REPLAY_HEADERS and value:
                out[key] = value
        return out

    def _apply_identity_headers(self, headers: dict[str, str], stream_snapshot: dict[str, Any] | None = None) -> dict[str, str]:
        if stream_snapshot is None:
            stream_snapshot = self._snapshot_stream(include_replay_map=False)
        referer = (stream_snapshot.get("referer") or "").strip()
        cookie = (stream_snapshot.get("cookie") or "").strip()
        user_agent = (stream_snapshot.get("user_agent") or "").strip()
        origin = (stream_snapshot.get("origin") or "").strip()

        if referer and "referer" not in headers:
            headers["referer"] = referer
        if cookie and "cookie" not in headers:
            headers["cookie"] = cookie
        if user_agent and "user-agent" not in headers:
            headers["user-agent"] = user_agent
        if origin and "origin" not in headers:
            headers["origin"] = origin
        if "accept" not in headers:
            headers["accept"] = "*/*"
        return headers

    def _stream_to_client(self, upstream_resp: Any, fallback_content_type: str = "application/octet-stream") -> None:
        content_type = upstream_resp.headers.get("Content-Type", "") or fallback_content_type
        status_code = getattr(upstream_resp, "status", 200) or 200

        self.send_response(status_code)
        self._send_cors_headers()
        self.send_header("Content-Type", content_type)
        for header_name, header_value in upstream_resp.headers.items():
            lname = str(header_name or "").lower()
            if not lname or lname in self.HOP_BY_HOP_HEADERS or lname == "content-type":
                continue
            if header_value:
                self.send_header(header_name, header_value)
        self.end_headers()

        while True:
            chunk = upstream_resp.read(64 * 1024)
            if not chunk:
                break
            self.wfile.write(chunk)

    # -------------------------------------------------------------------------
    # HTTP Method Dispatchers
    # -------------------------------------------------------------------------

    def do_OPTIONS(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/config":
            if self._reject_config_origin_if_needed():
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            return
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_POST(self) -> None:
        if self.path == "/set-stream":
            self._handle_set_stream()
            return
        if self.path == "/capture-event":
            self._handle_capture_event()
            return
        if self.path == "/capture-request":
            self._handle_capture_request()
            return
        if self.path == "/set-subtitle":
            self._handle_set_subtitle()
            return
        if self.path == "/api/config":
            self._handle_post_config()
            return
        if self.path == "/api/promote-candidate":
            self._handle_promote_candidate()
            return
        if self.path == "/api/clear-candidates":
            self._handle_clear_candidates()
            return
        if self.path == "/api/jimaku/manual-search":
            self._handle_jimaku_manual_search()
            return
        if self.path == "/api/jimaku/manual-use":
            self._handle_jimaku_manual_use()
            return
        if self.path == "/api/jimaku/manual-clear":
            self._handle_jimaku_manual_clear()
            return
        if self.path == "/api/subdl/manual-search":
            self._handle_subdl_manual_search()
            return
        if self.path == "/api/extract-audio":
            self._handle_extract_audio()
            return
        if self.path == "/api/extract-audio/cancel":
            self._handle_extract_audio_cancel()
            return
        if self.path == "/api/shutdown":
            self._handle_shutdown()
            return
        self._send_json(404, {"status": "error", "message": "Not found"})

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path in {"/", "/dashboard"}:
            self._handle_dashboard()
            return
        if path == "/mstream.png":
            self._handle_mstream_png()
            return
        if path.startswith("/assets/"):
            self._handle_assets(path)
            return
        if path == "/health":
            self._send_json(200, {"status": "ok", "service": "bridge_proxy"})
            return
        if path == "/api/current-stream":
            self._handle_current_stream()
            return
        if path == "/api/config":
            self._handle_get_config()
            return
        if path == "/api/logs":
            self._handle_get_logs(qs)
            return
        if path == "/api/candidates":
            self._handle_get_candidates()
            return
        if path == "/api/artwork":
            self._handle_get_artwork(qs)
            return
        if path == "/api/image":
            self._handle_get_image(qs)
            return
        if path == "/api/debug-episode":
            self._handle_debug_episode()
            return
        if path == "/api/stream-duration":
            self._handle_stream_duration(qs)
            return
        if path == "/api/extract-audio/progress":
            self._handle_extract_audio_progress()
            return
        if path == "/api/extract-audio/file":
            self._handle_extract_audio_file()
            return
        if path == "/stream.m3u8":
            self._handle_stream_proxy()
            return
        if path == "/stream-direct":
            self._handle_direct_stream_proxy()
            return
        if path == "/proxy-subtitle":
            self._handle_subtitle_proxy()
            return
        if path == "/proxy-subtitle-srt":
            self._handle_proxy_subtitle_srt()
            return
        if path == "/proxy-segment":
            self._handle_segment_proxy()
            return

        self._send_json(404, {"status": "error", "message": "Not found"})

    # -------------------------------------------------------------------------
    # UI & Static Asset Handlers
    # -------------------------------------------------------------------------

    def _handle_assets(self, path: str) -> None:
        import mimetypes

        safe_path = path.lstrip("/")
        # Prevent directory traversal
        if ".." in safe_path:
            self._send_json(403, {"status": "error", "message": "Forbidden"})
            return

        file_path = Path(__file__).parent / safe_path
        if not file_path.exists() or not file_path.is_file():
            self._send_json(404, {"status": "error", "message": "Asset not found"})
            return

        content_type, _ = mimetypes.guess_type(str(file_path))
        if not content_type:
            content_type = "application/octet-stream"

        body = file_path.read_bytes()
        try:
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", f"{content_type}; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, must-revalidate")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass

    def _handle_dashboard(self) -> None:
        html_path = _dashboard_html_path()
        if not html_path.exists():
            self._send_json(404, {"status": "error", "message": "dashboard.html not found"})
            return
        body = html_path.read_bytes()
        try:
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            return

    def _handle_mstream_png(self) -> None:
        png_path = _mstream_png_path()
        if not png_path.exists():
            self._send_json(404, {"status": "error", "message": "mstream.png not found"})
            return
        body = png_path.read_bytes()
        try:
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            return

    # -------------------------------------------------------------------------
    # Configuration & Logging Handlers
    # -------------------------------------------------------------------------

    def _handle_get_config(self) -> None:
        if self._reject_config_origin_if_needed():
            return
        api_key = load_jimaku_api_key()
        subdl_api_key = load_subdl_api_key()
        subdl_languages = load_subdl_languages()
        self._send_json(200, {
            "status": "ok",
            "jimaku_api_key_set": bool(api_key),
            "jimaku_api_key_preview": self._mask_secret(api_key),
            "subdl_api_key_set": bool(subdl_api_key),
            "subdl_api_key_preview": self._mask_secret(subdl_api_key),
            "subdl_languages": subdl_languages,
            "jimaku_active": _jimaku_worker is not None,
        }, allow_cors=False)

    def _handle_post_config(self) -> None:
        global _jimaku_worker
        if self._reject_config_origin_if_needed():
            return
        try:
            data = self._read_json_body()
        except Exception as exc:
            self._send_json(400, {"status": "error", "message": str(exc)}, allow_cors=False)
            return

        # Save to config file
        config_path = get_config_path()
        try:
            existing: dict[str, Any] = {}
            if config_path.exists():
                try:
                    existing = json.loads(config_path.read_text(encoding="utf-8"))
                except Exception:
                    existing = {}
            if not isinstance(existing, dict):
                existing = {}

            if "jimaku_api_key" in data:
                existing["jimaku_api_key"] = str(data["jimaku_api_key"]).strip()
            elif "api_key" in data:
                existing["jimaku_api_key"] = str(data["api_key"]).strip()
            if "subdl_api_key" in data:
                existing["subdl_api_key"] = str(data["subdl_api_key"]).strip()
            if "subdl_languages" in data:
                existing["subdl_languages"] = str(data["subdl_languages"]).strip().upper()

            existing.pop("api_key", None)
            config_path.write_text(json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception as exc:
            self._send_json(500, {"status": "error", "message": f"Failed to save config: {exc}"}, allow_cors=False)
            return

        # Hot-restart jimaku worker
        if _jimaku_worker is not None:
            try:
                _jimaku_worker.stop()
            except Exception:
                pass
            _jimaku_worker = None

        _jimaku_worker = _start_jimaku_worker()
        self._log("INFO", f"API key saved & Jimaku worker {'restarted' if _jimaku_worker else 'failed to start'}")

        _push_log("INFO", f"[BRIDGE] API key saved. worker={'active' if _jimaku_worker else 'inactive'}")
        self._send_json(200, {
            "status": "ok",
            "message": "API key saved",
            "jimaku_active": _jimaku_worker is not None,
        }, allow_cors=False)

    def _handle_get_logs(self, qs: dict[str, list[str]]) -> None:
        with LOG_LOCK:
            logs = list(LOG_BUFFER)
            total = LOG_TOTAL_COUNT
        try:
            since = int((qs.get("since") or ["0"])[0])
        except (ValueError, IndexError):
            since = 0

        slice_ = [entry for entry in logs if entry.get("id", 0) > since]
        self._send_json(200, {"status": "ok", "total": total, "entries": slice_})

    # -------------------------------------------------------------------------
    # Artwork & Image Proxy Handlers
    # -------------------------------------------------------------------------

    def _handle_get_artwork(self, qs: dict[str, list[str]]) -> None:
        if not REQUESTS_AVAILABLE:
            self._send_json(503, {"status": "error", "message": "requests not available"}, allow_cors=True)
            return

        title = (qs.get("title") or [""])[0].strip()
        if not title:
            self._send_json(400, {"status": "error", "message": "title is empty"}, allow_cors=True)
            return

        tmdb_api_key = load_tmdb_api_key()
        if not tmdb_api_key:
            self._send_json(200, {"coverUrl": "", "bannerUrl": ""}, allow_cors=True)
            return

        try:
            if BridgeProxyHandler._session is None:
                BridgeProxyHandler._session = _requests.Session()

            from utils.tmdb_search import generate_tmdb_queries, tmdb_search

            queries = generate_tmdb_queries(title)
            data = tmdb_search(BridgeProxyHandler._session, tmdb_api_key, queries)

            # Prioritize media with both poster and backdrop
            best_item = None
            for item in data:
                if item.get("media_type") in ("movie", "tv"):
                    if item.get("poster_path") and item.get("backdrop_path"):
                        best_item = item
                        break
                    elif not best_item and item.get("poster_path"):
                        best_item = item

            if best_item:
                poster = best_item.get("poster_path")
                backdrop = best_item.get("backdrop_path") or poster
                self._send_json(200, {
                    "coverUrl": f"http://{HOST}:{PORT}/api/image?url=https://image.tmdb.org/t/p/w500{poster}" if poster else "",
                    "bannerUrl": f"http://{HOST}:{PORT}/api/image?url=https://image.tmdb.org/t/p/w1280{backdrop}" if backdrop else ""
                }, allow_cors=True)
            else:
                self._send_json(200, {"coverUrl": "", "bannerUrl": ""}, allow_cors=True)
        except Exception:
            self._send_json(200, {"coverUrl": "", "bannerUrl": ""}, allow_cors=True)

    def _handle_get_image(self, qs: dict[str, list[str]]) -> None:
        url = (qs.get("url") or [""])[0].strip()
        if not url or not url.startswith("http"):
            self._send_json(400, {"status": "error", "message": "invalid url"}, allow_cors=True)
            return

        try:
            if BridgeProxyHandler._session is None:
                BridgeProxyHandler._session = _requests.Session()
            resp = BridgeProxyHandler._session.get(url, timeout=10)
            if resp.status_code != 200:
                self.send_response(resp.status_code)
                self.end_headers()
                return

            self.send_response(200)
            self.send_header("Content-Type", resp.headers.get("Content-Type", "image/jpeg"))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(resp.content)
        except Exception:
            self.send_response(500)
            self.end_headers()

    # -------------------------------------------------------------------------
    # Stream Candidate Management Handlers
    # -------------------------------------------------------------------------

    def _handle_get_candidates(self) -> None:
        with STATE_LOCK:
            items = [self._public_capture_candidate(item) for item in capture_candidates]
        self._send_json(200, {"status": "ok", "candidates": items})

    def _handle_promote_candidate(self) -> None:
        try:
            data = self._read_json_body()
        except Exception as exc:
            self._send_json(400, {"status": "error", "message": str(exc)})
            return

        candidate_id = str(data.get("id") or "").strip()
        with STATE_LOCK:
            candidate = next((dict(item) for item in capture_candidates if item.get("id") == candidate_id), None)
        if not candidate:
            self._send_json(404, {"status": "error", "message": "Candidate not found"})
            return

        promoted = self._promote_capture_candidate(candidate, forced=True)
        if not promoted:
            self._send_json(400, {"status": "error", "message": "Candidate could not be promoted"})
            return

        self._log(
            "INFO",
            "stream restored from captured list | "
            f"type={candidate.get('stream_type')} | "
            f"url={str(candidate.get('url') or '')[:160]}",
        )
        self._send_json(200, {"status": "ok", "promoted": True})

    def _handle_clear_candidates(self) -> None:
        with STATE_LOCK:
            capture_candidates.clear()
        self._send_json(200, {"status": "ok"})

    def _public_manual_subtitle_candidate(self, candidate: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": candidate.get("id"),
            "entry_id": candidate.get("entry_id"),
            "entry_name": candidate.get("entry_name"),
            "filename": candidate.get("filename"),
            "season": candidate.get("season"),
            "episode": candidate.get("episode"),
        }


    # -------------------------------------------------------------------------
    # Manual Subtitle Search Handlers (Jimaku & SubDL)
    # -------------------------------------------------------------------------

    def _handle_jimaku_manual_search(self) -> None:
        if self._reject_config_origin_if_needed():
            return
        if not REQUESTS_AVAILABLE:
            self._send_json(503, {"status": "error", "message": "requests is not available"}, allow_cors=False)
            return

        try:
            data = self._read_json_body()
        except Exception as exc:
            self._send_json(400, {"status": "error", "message": str(exc)}, allow_cors=False)
            return

        api_key = load_jimaku_api_key()
        if not api_key:
            self._send_json(400, {"status": "error", "message": "Jimaku API key is not saved"}, allow_cors=False)
            return

        query = re.sub(r"\s+", " ", str(data.get("query") or "")).strip()
        if not query:
            with STATE_LOCK:
                query = re.sub(r"\s+", " ", str(current_stream.get("title") or "")).strip()
        raw_title_candidates = data.get("title_candidates") or []
        if not raw_title_candidates:
            with STATE_LOCK:
                raw_title_candidates = list(current_stream.get("title_candidates") or [])
        title_candidates = raw_title_candidates if isinstance(raw_title_candidates, list) else []
        if not query:
            self._send_json(400, {"status": "error", "message": "Query is empty"}, allow_cors=False)
            return

        bridge = JimakuBridge(api_key=api_key, proxy_base_url=f"http://{HOST}:{PORT}")
        clean_query, _query_episode = bridge._parse_title(query)
        with STATE_LOCK:
            requested_season = (
                self._normalize_positive_int(data.get("season"))
                or JimakuBridge._extract_season_from_text(query)
                or self._normalize_positive_int(current_stream.get("season"))
            )

        external_aliases: list[str] = []
        allowed_global_titles: list[Any] = [query, clean_query, *title_candidates]
        search_queries = bridge._build_query_candidates(clean_query, title_candidates, requested_season)[:8]
        entries: list[dict[str, Any]] = []
        seen_entry_ids: set[int] = set()

        MANUAL_SIMILARITY_THRESHOLD = 0.15

        def add_entries(values: list[str], validation_queries: list[str]) -> None:
            for search_query in values:
                if len(entries) >= 10 or any(e.get("_similarity_score", 0.0) >= 0.95 for e in entries):
                    return
                for entry in bridge._search_jimaku_candidates(search_query, max_items=15):
                    entry_id = entry.get("id")
                    if not isinstance(entry_id, int) or entry_id in seen_entry_ids:
                        continue
                    eng = entry.get("english_name") or ""
                    jpn = entry.get("japanese_name") or ""
                    score = max(
                        *(bridge._title_similarity(q, eng) for q in validation_queries) if eng else [0.0],
                        *(bridge._title_similarity(q, jpn) for q in validation_queries) if jpn else [0.0],
                    )
                    if score < MANUAL_SIMILARITY_THRESHOLD:
                        continue
                    seen_entry_ids.add(entry_id)
                    entry["_similarity_score"] = score
                    entries.append(entry)

        add_entries(search_queries, [query, clean_query])
        if not entries:
            external_aliases = bridge._search_external_title_aliases([clean_query])
            if external_aliases:
                allowed_global_titles.extend(external_aliases)
                alias_queries = list(external_aliases)
                for q in bridge._build_query_candidates(
                    clean_query,
                    external_aliases,
                    requested_season,
                    allow_unrelated_candidates=True,
                ):
                    if q not in alias_queries:
                        alias_queries.append(q)

                add_entries(alias_queries[:8], [query, clean_query, *external_aliases])

        candidates: list[dict[str, Any]] = []

        if entries:
            best_score = max([e.get("_similarity_score", 0.0) for e in entries])
            entries = [e for e in entries if e.get("_similarity_score", 0.0) >= best_score - 0.25]

        for entry in entries:
            entry_id = entry.get("id")
            if not isinstance(entry_id, int):
                continue
            entry_english_name = str(entry.get("english_name") or "").strip()
            entry_japanese_name = str(entry.get("japanese_name") or "").strip()
            entry_name = entry_english_name or entry_japanese_name or f"Entry {entry_id}"
            entry_season = JimakuBridge._extract_season_from_text(str(entry_name or ""))
            files = bridge._get_srt_files(entry_id)
            files = sorted(
                files,
                key=lambda item: (
                    0 if _query_episode is not None and self._normalize_positive_int(JimakuBridge._extract_episode_from_filename(item.get("name") or "")) == _query_episode else 1,
                    self._normalize_positive_int(JimakuBridge._extract_season_from_text(item.get("name") or "")) or 999999,
                    1 if JimakuBridge._extract_episode_from_filename(item.get("name") or "") is None else 0,
                    self._normalize_positive_int(JimakuBridge._extract_episode_from_filename(item.get("name") or "")) or 999999,
                    0 if JimakuBridge._filename_has_japanese_text(item.get("name") or "") else 1,
                    str(item.get("name") or "").lower(),
                ),
            )
            valid_files = []
            for file_info in files:
                filename = str(file_info.get("name") or "").strip()
                file_url = str(file_info.get("url") or "").strip()
                if not filename or not file_url:
                    continue
                file_season = JimakuBridge._extract_season_from_text(filename)
                if requested_season and file_season is not None and file_season != requested_season:
                    continue
                if requested_season and file_season is None and entry_season is not None and entry_season != requested_season:
                    continue
                valid_files.append(file_info)

            if not valid_files and files and requested_season:
                if entry_season == requested_season:
                    valid_files = files

            for file_info in valid_files:
                filename = str(file_info.get("name") or "").strip()
                file_url = str(file_info.get("url") or "").strip()
                if not filename or not file_url:
                    continue
                file_season = JimakuBridge._extract_season_from_text(filename)
                candidate_id = hashlib.sha1(
                    f"{entry_id}|{filename}|{file_url}".encode("utf-8", errors="ignore")
                ).hexdigest()[:16]
                candidates.append(
                    {
                        "id": candidate_id,
                        "entry_id": entry_id,
                        "entry_name": entry_name,
                        "filename": filename,
                        "season": file_season or entry_season,
                        "entry_season": entry_season,
                        "episode": JimakuBridge._extract_episode_from_filename(filename),
                        "url": file_url,
                        "score": entry.get("_similarity_score", 0.0),
                    }
                )
                if len(candidates) >= MAX_MANUAL_SUBTITLE_CANDIDATES:
                    break
            if len(candidates) >= MAX_MANUAL_SUBTITLE_CANDIDATES:
                break

        candidates = sorted(
            candidates,
            key=lambda item: (
                0 if requested_season and (item.get("season") == requested_season or item.get("entry_season") == requested_season) else 1 if requested_season else 0,
                -item.get("score", 0.0),
                0 if _query_episode is not None and item.get("episode") == _query_episode else 1,
                -JimakuBridge._score_subtitle_file(item.get("filename") or ""),
                self._normalize_positive_int(item.get("season")) or 999999,
                1 if item.get("episode") is None else 0,
                self._normalize_positive_int(item.get("episode")) or 999999,
                str(item.get("filename") or "").lower(),
            ),
        )[:MAX_MANUAL_SUBTITLE_CANDIDATES]

        with STATE_LOCK:
            manual_subtitle_candidates.clear()
            manual_subtitle_candidates.extend(candidates)

        self._log("INFO", f"manual Jimaku search | query={query} | files={len(candidates)}")
        self._send_json(
            200,
            {
                "status": "ok",
                "query": query,
                "candidates": [self._public_manual_subtitle_candidate(item) for item in candidates],
            },
            allow_cors=False,
        )

    def _handle_jimaku_manual_use(self) -> None:
        if self._reject_config_origin_if_needed():
            return
        if not REQUESTS_AVAILABLE:
            self._send_json(503, {"status": "error", "message": "requests is not available"}, allow_cors=False)
            return

        try:
            data = self._read_json_body()
        except Exception as exc:
            self._send_json(400, {"status": "error", "message": str(exc)}, allow_cors=False)
            return

        candidate_id = str(data.get("id") or "").strip()
        sub_filename = str(data.get("sub_filename") or "").strip()
        with STATE_LOCK:
            candidate = next((dict(item) for item in manual_subtitle_candidates if item.get("id") == candidate_id), None)
            stream_key_before = _stream_key(current_stream.get("title"), current_stream.get("stream_url"))
            current_ep = (self._normalize_positive_int(candidate.get("episode")) if candidate else None) or self._normalize_positive_int(current_stream.get("episode"))

        if not candidate:
            self._send_json(404, {"status": "error", "message": "Subtitle candidate not found"}, allow_cors=False)
            return
        if not stream_key_before:
            self._send_json(409, {"status": "error", "message": "No active stream"}, allow_cors=False)
            return

        is_subdl = candidate.get("_subdl", False)
        zip_files = None

        if is_subdl:
            try:
                provider = SubdlProvider("dummy")
                srt_bytes, result = provider.download(str(candidate.get("url") or ""), current_ep, sub_filename)
                if not srt_bytes:
                    self._send_json(200, {"status": "needs_selection", "files": result}, allow_cors=False)
                    return
                filename = result
                zip_files = None
            except Exception as exc:
                self._send_json(502, {"status": "error", "message": f"Failed to download/extract Subdl ZIP: {exc}"}, allow_cors=False)
                return
        else:
            api_key = load_jimaku_api_key()
            if not api_key:
                self._send_json(400, {"status": "error", "message": "Jimaku API key is not saved"}, allow_cors=False)
                return
            bridge = JimakuBridge(api_key=api_key, proxy_base_url=f"http://{HOST}:{PORT}")
            try:
                srt_bytes = bridge._download_srt(str(candidate.get("url") or ""))
                filename = str(candidate.get("filename") or "").strip() or "subtitle.srt"
            except Exception as exc:
                self._send_json(502, {"status": "error", "message": f"Failed to download SRT: {exc}"}, allow_cors=False)
                return

        srt_content = srt_bytes.decode("utf-8-sig", errors="replace")
        subtitle_url = f"http://{HOST}:{PORT}/proxy-subtitle-srt"

        with STATE_LOCK:
            stream_key_now = _stream_key(current_stream.get("title"), current_stream.get("stream_url"))
            if stream_key_now != stream_key_before:
                self._send_json(
                    409,
                    {"status": "error", "message": "Active stream changed. Search again."},
                    allow_cors=False,
                )
                return
            current_stream["subtitle_url"] = subtitle_url
            current_stream["subtitle_filename"] = filename
            current_stream["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            srt_store["content"] = srt_content
            srt_store["filename"] = filename
            manual_subtitle_pin["stream_key"] = stream_key_now
            manual_subtitle_pin["filename"] = filename

        source_label = "Subdl" if is_subdl else "Jimaku"
        self._log("INFO", f"manual {source_label} subtitle selected | filename={filename}")

        resp: dict[str, Any] = {"status": "ok", "filename": filename, "subtitle_url": subtitle_url}
        if zip_files:
            resp["files"] = zip_files

        self._send_json(200, resp, allow_cors=False)

    def _handle_subdl_manual_search(self) -> None:
        if self._reject_config_origin_if_needed():
            return
        if not REQUESTS_AVAILABLE:
            self._send_json(503, {"status": "error", "message": "requests is not available"}, allow_cors=False)
            return

        try:
            data = self._read_json_body()
        except Exception as exc:
            self._send_json(400, {"status": "error", "message": str(exc)}, allow_cors=False)
            return

        api_key = load_subdl_api_key()
        if not api_key:
            self._send_json(400, {"status": "error", "message": "Subdl API key is not saved"}, allow_cors=False)
            return

        query = re.sub(r"\s+", " ", str(data.get("query") or "")).strip()
        if not query:
            with STATE_LOCK:
                query = re.sub(r"\s+", " ", str(current_stream.get("title") or "")).strip()

        if not query:
            self._send_json(400, {"status": "error", "message": "Query is empty"}, allow_cors=False)
            return

        bridge = JimakuBridge(api_key="dummy", proxy_base_url=f"http://{HOST}:{PORT}")
        clean_query, _query_episode = bridge._parse_title(query)
        if not clean_query:
            clean_query = query

        with STATE_LOCK:
            requested_season = (
                self._normalize_positive_int(data.get("season"))
                or JimakuBridge._extract_season_from_text(query)
                or self._normalize_positive_int(current_stream.get("season"))
            )
            requested_episode = (
                self._normalize_positive_int(data.get("episode"))
                or _query_episode
                or self._normalize_positive_int(current_stream.get("episode"))
            )

        provider = SubdlProvider(api_key)
        try:
            candidates = provider.search(clean_query, requested_season, requested_episode)
            with STATE_LOCK:
                manual_subtitle_candidates.clear()
                manual_subtitle_candidates.extend(candidates)
            self._send_json(200, {"status": "ok", "candidates": candidates}, allow_cors=False)
        except ValueError as e:
            self._send_json(400, {"status": "error", "message": str(e)}, allow_cors=False)
        except Exception as e:
            self._send_json(500, {"status": "error", "message": f"Subdl request failed: {e}"}, allow_cors=False)

    def _handle_jimaku_manual_clear(self) -> None:
        if self._reject_config_origin_if_needed():
            return
        with STATE_LOCK:
            manual_subtitle_candidates.clear()
        self._send_json(200, {"status": "ok"}, allow_cors=False)

    # -------------------------------------------------------------------------
    # Server Lifecycle Handlers
    # -------------------------------------------------------------------------

    def _handle_shutdown(self) -> None:
        """Stop the local bridge without relying on release helper scripts."""
        _push_log("WARN", "[BRIDGE] shutdown requested by user.")
        self._send_json(200, {"status": "ok", "message": "shutdown initiated"})
        server_instance = self.server

        def _do_kill() -> None:
            time.sleep(0.4)  # Give the response and one log fetch time to complete.
            try:
                worker = globals().get("_jimaku_worker")
                if worker:
                    worker.stop()
            except Exception:
                pass
            try:
                server_instance.shutdown()
            except Exception:
                pass

        threading.Thread(target=_do_kill, daemon=True).start()


    # -------------------------------------------------------------------------
    # Stream Capture & Promotion Engine
    # -------------------------------------------------------------------------

    def _capture_meta_for_tab(self, tab_id: int) -> dict[str, Any]:
        if tab_id < 0:
            return {}
        with STATE_LOCK:
            return dict(capture_tab_meta.get(tab_id) or {})

    def _store_capture_candidate(self, candidate: dict[str, Any]) -> None:
        with STATE_LOCK:
            existing_index = None
            for idx, item in enumerate(capture_candidates):
                if item.get("id") == candidate.get("id"):
                    existing_index = idx
                    break
            if existing_index is not None:
                capture_candidates.pop(existing_index)
            capture_candidates.insert(0, candidate)
            del capture_candidates[MAX_CAPTURE_CANDIDATES:]

    def _public_capture_candidate(self, candidate: dict[str, Any]) -> dict[str, Any]:
        current_url = str(current_stream.get("stream_url") or "")
        current_key = self._normalize_header_map_key(current_url) or current_url
        cand_key = candidate.get("url_key") or candidate.get("url") or ""

        is_active = False
        if current_url:
            is_active = bool(
                candidate.get("url") == current_url
                or (cand_key and cand_key == current_key)
            )
        raw_title = candidate.get("display_title") or candidate.get("title") or ""
        res: dict[str, Any] = {
            "id": candidate.get("id"),
            "url": candidate.get("url"),
            "url_key": candidate.get("url_key"),
            "stream_type": candidate.get("stream_type"),
            "title": candidate.get("title"),
            "display_title": candidate.get("display_title"),
            "clean_title": clean_media_title(raw_title),
            "page_url": candidate.get("page_url"),
            "source_host": candidate.get("source_host"),
            "stream_host": candidate.get("stream_host"),
            "score": candidate.get("score"),
            "confidence": candidate.get("confidence"),
            "updated_at": candidate.get("updated_at"),
            "episode": candidate.get("episode"),
            "season": candidate.get("season"),
            "active": is_active,
        }

        tmdb_data = candidate.get("tmdb")
        if tmdb_data:
            poster = tmdb_data.get("poster")
            backdrop = tmdb_data.get("backdrop")
            if poster:
                res["cover_url"] = f"http://{HOST}:{PORT}/api/image?url=https://image.tmdb.org/t/p/w500{poster}"
            if backdrop:
                res["banner_url"] = f"http://{HOST}:{PORT}/api/image?url=https://image.tmdb.org/t/p/w1280{backdrop}"

        return res

    def _promote_capture_candidate(self, candidate: dict[str, Any], forced: bool = False) -> bool:
        now = time.time()
        url = self._normalize_url(candidate.get("url") or "")
        if not url:
            return False
        if not self._is_valid_http_url(url):
            return False
        if _is_bridge_local_url(url):
            return False
        if _is_subtitle_like_url(url):
            return False
        if self._is_probably_audio_direct(url):
            return False

        with STATE_LOCK:
            protected_page_url = current_stream.get("page_url") or ""
            current_stream["ownership"] = {
                "mode": "manual_restore",
                "page_url": self._normalize_url(protected_page_url),
                "stream_url": url,
                "created_at": now,
            }

        headers = self._sanitize_forward_headers(candidate.get("headers") or {})
        url_key = self._normalize_header_map_key(candidate.get("url_key") or url)
        score = int(candidate.get("score") or 0)
        confidence = int(candidate.get("confidence") or 0)
        stream_type = self._infer_stream_type(url, candidate.get("stream_type") or "")
        title = str(candidate.get("title") or "").strip() or "Captured by Bridge Extension"
        title_candidates = candidate.get("title_candidates") if isinstance(candidate.get("title_candidates"), list) else []
        episode = self._normalize_positive_int(candidate.get("episode"))
        season = self._normalize_positive_int(candidate.get("season"))

        with STATE_LOCK:
            current_score = int(capture_active_state.get("score") or 0)
            current_key = str(capture_active_state.get("url_key") or "")
            current_age = now - float(capture_active_state.get("updated_at") or 0)
            existing_master_url = self._normalize_url(current_stream.get("hls_master_url") or current_stream.get("stream_url") or "")
            if (
                not forced
                and stream_type == "hls"
                and self._is_hls_variant_url(url)
                and self._is_hls_master_url(existing_master_url)
                and self._same_hls_session(existing_master_url, url)
            ):
                return False
            is_same_stream = url_key == current_key
            should_promote = forced or is_same_stream or (
                confidence >= 60
                and score >= 700
                and (
                    not current_stream.get("stream_url")
                    or score >= current_score
                    or current_age > 8
                )
            )
            if not should_promote:
                return False

            _clear_manual_pin_if_stream_changed_unlocked(title, url)
            current_stream["stream_url"] = url
            current_stream["stream_type"] = stream_type
            current_stream["m3u8_url"] = url if stream_type == "hls" else ""
            print(f"[STATE] episode changed | {current_stream.get('episode')} -> {episode} | reason=promote_candidate | title={title}")
            current_stream["episode"] = episode
            current_stream["season"] = season
            current_stream["detected_episode"] = None
            self._merge_title(current_stream, title, "promote_candidate", False, False, user_override=True)
            current_stream.pop("tmdb", None)
            from services.tmdb_service import TMDBService
            TMDBService.get_instance().request_artwork(current_stream)
            current_stream["title_candidates"] = title_candidates
            current_stream["content_type"] = self._guess_content_type(url)
            if stream_type == "hls" and (self._is_hls_master_url(url) or not existing_master_url):
                current_stream["hls_master_url"] = url
            if headers:
                if headers.get("referer"):
                    current_stream["referer"] = headers.get("referer")
                if headers.get("origin"):
                    current_stream["origin"] = headers.get("origin")
                if headers.get("cookie"):
                    current_stream["cookie"] = headers.get("cookie")
                if headers.get("user-agent"):
                    current_stream["user_agent"] = headers.get("user-agent")
                current_stream["request_headers"] = headers
            current_stream["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            capture_active_state.update({
                "score": score,
                "url_key": url_key,
                "tab_id": int(candidate.get("tab_id") or -1),
                "updated_at": now,
            })
            return True

    def _store_capture_headers(self, url: str, url_key: str, headers: dict[str, Any]) -> int:
        if not headers:
            return 0
        with STATE_LOCK:
            header_map = current_stream.get("url_header_map") or {}
            if not isinstance(header_map, dict):
                header_map = {}
            header_map = dict(header_map)
            header_map[url] = headers
            if url_key:
                header_map[url_key] = headers
            header_map = self._trim_header_map(header_map)
            current_stream["url_header_map"] = header_map

            if headers.get("cookie"):
                current_stream["cookie"] = headers.get("cookie")
            if headers.get("referer"):
                current_stream["referer"] = headers.get("referer")
            if headers.get("origin"):
                current_stream["origin"] = headers.get("origin")
            if headers.get("user-agent"):
                current_stream["user_agent"] = headers.get("user-agent")
            current_stream["request_headers"] = headers
            current_stream["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            return len(header_map)

    def _promote_capture_stream(self, url: str, url_key: str, data: dict[str, Any], headers: dict[str, Any], score: int) -> bool:
        if _is_bridge_local_url(url):
            return False
        if _is_subtitle_like_url(url):
            return False
        tab_id = self._capture_tab_id(data)
        meta = self._capture_meta_for_tab(tab_id)
        now = time.time()
        stream_type = self._infer_stream_type(url)
        title = meta.get("title") or self._clean_url(data.get("document_url") or data.get("initiator") or "") or "Captured by Bridge Extension"
        title_candidates = meta.get("title_candidates") or []
        episode = self._normalize_positive_int(meta.get("episode"))
        season = self._normalize_positive_int(meta.get("season"))

        with STATE_LOCK:
            current_score = int(capture_active_state.get("score") or 0)
            current_key = str(capture_active_state.get("url_key") or "")
            current_age = now - float(capture_active_state.get("updated_at") or 0)
            existing_master_url = self._normalize_url(current_stream.get("hls_master_url") or current_stream.get("stream_url") or "")
            if (
                stream_type == "hls"
                and self._is_hls_variant_url(url)
                and self._is_hls_master_url(existing_master_url)
                and self._same_hls_session(existing_master_url, url)
            ):
                return False
            should_promote = (
                not current_stream.get("stream_url")
                or score >= current_score
                or url_key == current_key
                or current_age > 8
            )
            if not should_promote:
                return False

            _clear_manual_pin_if_stream_changed_unlocked(title, url)
            current_stream.pop("ownership", None)
            current_stream["stream_url"] = url
            current_stream["stream_type"] = stream_type
            current_stream["m3u8_url"] = url if stream_type == "hls" else ""
            if title != current_stream.get("title"):
                print(f"[STATE] episode changed | {current_stream.get('episode')} -> {episode} | reason=direct_stream_title_changed | title={title}")
                current_stream["episode"] = episode
                current_stream["season"] = season
                current_stream["detected_episode"] = None
            else:
                if episode is not None:
                    print(f"[STATE] episode changed | {current_stream.get('episode')} -> {episode} | reason=direct_stream_title_match")
                    current_stream["episode"] = episode
                else:
                    print(f"[STATE] episode preserved | current={current_stream.get('episode')} | incoming={episode} | reason=direct_stream_title_match_skip")
                if season is not None:
                    current_stream["season"] = season
            self._merge_title(current_stream, title, "direct_stream", False, False, user_override=True)
            current_stream["title_candidates"] = title_candidates
            current_stream["content_type"] = self._guess_content_type(url)
            if stream_type == "hls" and (self._is_hls_master_url(url) or not existing_master_url):
                current_stream["hls_master_url"] = url
            if headers:
                if headers.get("referer"):
                    current_stream["referer"] = headers.get("referer")
                if headers.get("origin"):
                    current_stream["origin"] = headers.get("origin")
                if headers.get("cookie"):
                    current_stream["cookie"] = headers.get("cookie")
                if headers.get("user-agent"):
                    current_stream["user_agent"] = headers.get("user-agent")
                current_stream["request_headers"] = headers
            current_stream["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            capture_active_state.update({
                "score": score,
                "url_key": url_key,
                "tab_id": tab_id,
                "updated_at": now,
            })
            return True

    # -------------------------------------------------------------------------
    # Audio Extractor Handlers
    # -------------------------------------------------------------------------

    def _handle_extract_audio(self) -> None:
        snapshot = self._snapshot_stream()
        url = snapshot.get("stream_url") or snapshot.get("hls_master_url") or ""
        if not url:
            self._send_json(400, {"status": "error", "message": "No active stream found."})
            return

        # Fallback to master playlist if active stream is a high-res variant
        parsed_url = urllib.parse.urlparse(url)
        if parsed_url.path.endswith(".m3u8") and not any(kw in url.lower() for kw in ["master", "main"]):
            active_host = parsed_url.netloc
            with STATE_LOCK:
                for cand in capture_candidates:
                    c_url = cand.get("url", "")
                    if any(kw in c_url.lower() for kw in ["master", "main"]) and urllib.parse.urlparse(c_url).netloc == active_host:
                        url = c_url
                        break

        header_dict, _ = self._find_hls_headers_for_url(url, stream_snapshot=snapshot)
        stream_type = snapshot.get("stream_type", "hls")

        # Pass original URL, headers, and stream type to extractor for direct CDN fetch
        start_extraction_async(url, header_dict, stream_type=stream_type)
        self._send_json(200, {"status": "ok", "message": "Extraction started"})

    def _handle_extract_audio_cancel(self) -> None:
        cancel_extraction()
        self._send_json(200, {"status": "ok", "message": "Extraction cancelled"})

    def _handle_extract_audio_progress(self) -> None:
        dl_status = get_download_status()
        if dl_status in ["downloading", "idle"]:
            self._send_json(200, {
                "status": "downloading_ffmpeg",
                "percent": 0,
                "message": "Downloading FFmpeg dependencies...",
            })
            return
        ext_status = get_extraction_status()
        self._send_json(200, ext_status)

    def _handle_extract_audio_file(self) -> None:
        path = get_audio_temp_path()
        if not path.exists():
            self._send_json(404, {"status": "error", "message": "Audio file not found."})
            return
        try:
            file_size = os.path.getsize(path)
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(file_size))
            self.send_header("Content-Disposition", 'inline; filename="dummy_audio.mp4"')
            self.end_headers()
            with open(path, "rb") as f:
                while chunk := f.read(64 * 1024):
                    self.wfile.write(chunk)
        except Exception as exc:
            self._log("ERROR", f"Failed to serve audio file: {exc}")


class QuietThreadingHTTPServer(http.server.ThreadingHTTPServer):
    """ThreadingHTTPServer that silently swallows expected client-disconnect errors."""

    daemon_threads = True

    def handle_error(self, request, client_address):
        exc_type, exc, _tb = sys.exc_info()
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


# =============================================================================
# Server Initialization & Splash Screen
# =============================================================================

def run_server() -> None:
    global _jimaku_worker
    _ensure_console_safe_stdio()
    ensure_config_exists()
    dashboard_url = _dashboard_url()

    if _bridge_health_ok():
        _open_dashboard()
        return

    try:
        server = QuietThreadingHTTPServer((HOST, PORT), BridgeProxyHandler)
    except OSError as exc:
        if _bridge_health_ok(timeout=1.0):
            _open_dashboard()
            return
        _show_startup_error(
            f"M-Stream Bridge could not start on {dashboard_url}.\n\n"
            f"Port {PORT} is already in use or unavailable.\n\n"
            f"Details: {exc}"
        )
        return

    print()
    print("=" * 72)
    print("M-Stream Bridge v__VERSION__")
    print("=" * 72)
    print(f"Dashboard  : http://{HOST}:{PORT}")
    print(f"Bridge API : http://{HOST}:{PORT}")
    print("Endpoint   :")
    print("  [UI & Core]")
    print("  - GET  /              (Dashboard UI)")
    print("  - GET  /assets/*      (Static Assets)")
    print("  - GET  /mstream.png   (Favicon)")
    print("  - GET  /health        (Health Check)")
    print("  - POST /api/shutdown  (Graceful Exit)")
    print("  [Stream & Capture]")
    print("  - POST /set-stream")
    print("  - POST /update-meta")
    print("  - POST /capture-event")
    print("  - POST /capture-request")
    print("  - GET  /api/current-stream")
    print("  - GET  /api/stream-duration")
    print("  - GET  /api/debug-episode")
    print("  - GET  /api/candidates")
    print("  - POST /api/promote-candidate")
    print("  - POST /api/clear-candidates")
    print("  [Proxy API]")
    print("  - GET  /stream.m3u8")
    print("  - GET  /stream-direct")
    print("  - GET  /proxy-segment?url=<encoded>")
    print("  - GET  /proxy-subtitle")
    print("  - GET  /proxy-subtitle-srt")
    print("  - POST /set-subtitle")
    print("  [Audio Extraction]")
    print("  - POST /api/extract-audio")
    print("  - GET  /api/extract-audio/progress")
    print("  - GET  /api/extract-audio/file")
    print("  - POST /api/extract-audio/cancel")
    print("  [Data & Settings]")
    print("  - GET  /api/artwork")
    print("  - GET  /api/image")
    print("  - GET  /api/config")
    print("  - POST /api/config")
    print("  - GET  /api/logs")
    print("  [Jimaku Subtitles]")
    print("  - POST /api/jimaku/manual-search")
    print("  - POST /api/jimaku/manual-use")
    print("  - POST /api/jimaku/manual-clear")
    print("  [SubDL Subtitles]")
    print("  - POST /api/subdl/manual-search")
    print(f"Log level  : {LOG_LEVEL}")
    print(f"Map limit  : total={MAX_URL_HEADER_MAP}, per_host={MAX_URL_HEADER_MAP_PER_HOST}")
    print("=" * 72)
    download_ffmpeg_async()
    _jimaku_worker = _start_jimaku_worker()
    if _jimaku_worker:
        print("[SERVICES] Jimaku polling worker: active")
    else:
        print("[SERVICES] Jimaku polling worker: inactive")

    threading.Timer(0.8, _open_dashboard).start()
    print(f"[BRIDGE] opening dashboard: {dashboard_url}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[BRIDGE] server stopped.")
    finally:
        if _jimaku_worker:
            try:
                _jimaku_worker.stop()
            except Exception as exc:
                print(f"[JIMAKU] worker stop warning: {exc}")
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    run_server()

