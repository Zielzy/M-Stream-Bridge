# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     __VERSION__
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
"""
HLS Playlist Rewriter, MPEG-TS Segment Demuxer, and Media Streaming Mixin.
"""

from __future__ import annotations

import datetime
import http.client as http
import json
import random
import re
import socket
import threading
import time
from typing import Any
import urllib.parse
import urllib.request
from urllib.error import HTTPError, URLError

try:
    import requests as _requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False

from core.cloudflare import (
    _CF_COOKIES,
    _set_cookie_header,
    _set_ua_header,
    _solve_cloudflare_turnstile,
)
from core.config import get_config_path
from core.state import (
    HOST,
    LOG_PREFIX,
    MAX_BODY_BYTES,
    PORT,
    SEGMENT_521_RETRY_ATTEMPTS,
    SEGMENT_521_RETRY_DELAY_SEC,
    SEGMENT_TRANSIENT_RETRY_ATTEMPTS,
    SEGMENT_TRANSIENT_RETRY_DELAY_SEC,
    STATE_LOCK,
    current_stream,
    set_host_pause,
    srt_store,
    wait_if_host_paused,
)

PROXY_MAX_CONCURRENCY: int = 6
# Limit proxy request concurrency to avoid IP blocking by target CDN
_SEGMENT_PROXY_SEMAPHORE: threading.Semaphore = threading.Semaphore(PROXY_MAX_CONCURRENCY)
_CACHE_LOCK: threading.Lock = threading.Lock()
_MASTER_TO_MEDIA_CACHE: dict[str, str] = {}


class HlsProxyMixin:
    """Mixin class providing HLS/DASH proxying, playlist rewriting, and segment streaming."""

    # =========================================================================
    # Variant & Playlist Analysis
    # =========================================================================

    def _get_best_media_playlist_uri(self, text: str) -> str | None:
        """
        Parse a Master Playlist and select the best Variant Stream (Media Playlist).

        Strategy: Highest bandwidth variant.
        """
        lines = text.splitlines()
        best_uri = None
        max_bw = -1

        for i, line in enumerate(lines):
            if line.startswith("#EXT-X-STREAM-INF:"):
                bw_match = re.search(r"BANDWIDTH=(\d+)", line)
                bw = int(bw_match.group(1)) if bw_match else 0

                if bw > max_bw:
                    for j in range(i + 1, len(lines)):
                        uri_line = lines[j].strip()
                        if uri_line and not uri_line.startswith("#"):
                            max_bw = bw
                            best_uri = uri_line
                            break
        return best_uri

    def _classify_m3u8_text(self, text: str) -> tuple[str, bool, bool, bool]:
        """Classify M3U8 playlist kind (master, media, unknown) and detect tag flags."""
        has_stream_inf = "#EXT-X-STREAM-INF" in text
        has_media = "#EXT-X-MEDIA" in text
        has_extinf = "#EXTINF:" in text
        if has_stream_inf:
            kind = "master"
        elif has_extinf:
            kind = "media"
        else:
            kind = "unknown"
        return kind, has_stream_inf, has_media, has_extinf

    def _payload_looks_m3u8(self, data: bytes) -> bool:
        """Return True if the initial bytes match the standard #EXTM3U header."""
        return bool(data and data[:512].lstrip().startswith(b"#EXTM3U"))

    # =========================================================================
    # Upstream Header Builders
    # =========================================================================

    def _build_hls_upstream_headers(self, target_url: str) -> dict[str, Any] | None:
        """Construct request headers tailored to the target HLS CDN endpoint."""
        stream_snapshot = self._snapshot_stream()
        picked, lookup_mode = self._find_hls_headers_for_url(target_url, stream_snapshot)
        base = self._sanitize_forward_headers(stream_snapshot.get("request_headers") or {})
        map_size = len(stream_snapshot.get("url_header_map") or {})
        using_fallback = False
        headers = dict(picked)

        if not headers:
            using_fallback = True
            headers = dict(base)
        client_replay_headers = self._extract_client_replay_headers()

        # If there is no specific replay data at all, fail fast.
        if lookup_mode == "none" and not picked and not base and not map_size:
            return None

        headers.update(client_replay_headers)
        headers = self._apply_identity_headers(headers, stream_snapshot)

        # CDN Header Isolation: avoid leaking unrelated website cookies to third-party CDNs
        target_parsed = urllib.parse.urlparse(target_url)
        target_netloc = (target_parsed.netloc or "").lower()
        page_ref = stream_snapshot.get("referer") or stream_snapshot.get("page_url") or ""
        ref_parsed = urllib.parse.urlparse(page_ref) if page_ref else None
        ref_netloc = (ref_parsed.netloc or "").lower() if ref_parsed else ""

        is_known_cdn = any(
            cdn in target_netloc
            for cdn in [
                "tiktokcdn.com",
                "byteoversea.com",
                "akamaized.net",
                "bunnycdn.com",
                "fastly.net",
                "cloudfront.net",
                "cdn.cloudflare.net",
            ]
        )
        if is_known_cdn and ref_netloc and not target_netloc.endswith(ref_netloc):
            headers.pop("cookie", None)

        normalized_target = self._normalize_header_map_key(target_url)
        lookup_level = "DEBUG"
        lookup_key = f"hls_header_lookup:{lookup_mode}:{normalized_target[:90]}"
        self._log_throttled(
            lookup_key,
            lookup_level,
            "hls header lookup | "
            f"target={target_url[:140]} | "
            f"mode={lookup_mode} | "
            f"fallback={using_fallback} | "
            f"map_size={map_size} | "
            f"has_cookie={'cookie' in headers} | "
            f"has_referer={'referer' in headers} | "
            f"has_origin={'origin' in headers}",
            interval_seconds=6,
        )
        return headers

    def _build_direct_upstream_headers(self) -> dict[str, Any]:
        """Construct request headers for direct video streaming."""
        stream_snapshot = self._snapshot_stream(include_replay_map=False)
        replay_headers = self._sanitize_forward_headers(stream_snapshot.get("request_headers") or {})
        replay_headers.update(self._extract_client_replay_headers())
        return self._apply_identity_headers(replay_headers, stream_snapshot)

    # =========================================================================
    # M3U8 Playlist Rewriting Engine
    # =========================================================================

    def _rewrite_tag_uri_playlist(self, line: str, base_url: str) -> str:
        """Rewrite URI tags in master playlists (e.g. #EXT-X-MEDIA) to point to proxy-segment."""
        match = re.search(r'URI="([^"]+)"', line)
        if not match:
            return line
        uri_value = match.group(1)
        absolute = urllib.parse.urljoin(base_url, uri_value)
        encoded = urllib.parse.quote(absolute, safe="")
        proxied = f'URI="http://{HOST}:{PORT}/proxy-segment?url={encoded}"'
        return re.sub(r'URI="[^"]+"', proxied, line)

    def _rewrite_tag_uri_segment(self, line: str, base_url: str) -> str:
        """Rewrite URI tags in media playlists (e.g. #EXT-X-MAP, #EXT-X-KEY) to point to binary segment proxy."""
        match = re.search(r'URI="([^"]+)"', line)
        if not match:
            return line
        uri_value = match.group(1)
        absolute = urllib.parse.urljoin(base_url, uri_value)
        encoded = urllib.parse.quote(absolute, safe="")
        proxied = f'URI="http://{HOST}:{PORT}/proxy-segment?url={encoded}"'
        return re.sub(r'URI="[^"]+"', proxied, line)

    def _reorder_master_playlist(self, text: str) -> str:
        """
        Sort #EXT-X-STREAM-INF variants in a master playlist so that the highest
        resolution (or highest bandwidth) is placed first.
        """
        lines = text.splitlines()
        if not any(l.startswith("#EXT-X-STREAM-INF") for l in lines):
            return text

        header_lines: list[str] = []
        variants: list[str] = []
        current_variant_lines: list[str] = []
        in_variant = False

        for line in lines:
            if line.startswith("#EXT-X-STREAM-INF"):
                in_variant = True
                current_variant_lines.append(line)
            elif in_variant:
                current_variant_lines.append(line)
                if not line.startswith("#"):
                    variants.append("\n".join(current_variant_lines))
                    current_variant_lines = []
                    in_variant = False
            else:
                header_lines.append(line)

        if not variants:
            return text

        def get_score(v_text: str) -> tuple[int, int]:
            bw_match = re.search(r"BANDWIDTH=(\d+)", v_text)
            bw = int(bw_match.group(1)) if bw_match else 0
            res_match = re.search(r"RESOLUTION=(\d+)x(\d+)", v_text)
            res = int(res_match.group(1)) * int(res_match.group(2)) if res_match else 0
            return (res, bw)

        variants.sort(key=get_score, reverse=True)
        return "\n".join(header_lines) + "\n" + "\n".join(variants) + "\n"

    def _rewrite_master_playlist(self, content: str, base_url: str) -> str:
        """
        Rewrite a Master Playlist (.m3u8):
        - Rewrites #EXT-X-MEDIA URI="..." to /proxy-segment?url=...
        - Rewrites variant URIs under #EXT-X-STREAM-INF to /proxy-segment?url=...
        """
        content = self._reorder_master_playlist(content)
        rewritten_lines: list[str] = []
        lines = content.splitlines()
        in_stream_inf = False

        for raw_line in lines:
            line = raw_line.rstrip("\r\n")
            if not line:
                rewritten_lines.append(line)
                continue

            if line.startswith("#EXT-X-MEDIA") and 'URI="' in line:
                line = self._rewrite_tag_uri_playlist(line, base_url)
                rewritten_lines.append(line)
                continue

            if line.startswith("#EXT-X-STREAM-INF"):
                in_stream_inf = True
                rewritten_lines.append(line)
                continue

            if in_stream_inf and not line.startswith("#"):
                in_stream_inf = False
                absolute = urllib.parse.urljoin(base_url, line)
                encoded = urllib.parse.quote(absolute, safe="")
                rewritten_lines.append(f"http://{HOST}:{PORT}/proxy-segment?url={encoded}")
                continue

            rewritten_lines.append(line)

        return "\n".join(rewritten_lines)

    def _rewrite_media_playlist(self, content: str, base_url: str) -> str:
        """
        Rewrite a Media Playlist (.m3u8):
        - Rewrites #EXT-X-MAP and #EXT-X-KEY URI="..." to /proxy-segment?url=...
        - Rewrites binary segment lines (.ts, .m4s) to /proxy-segment?url=...
        - Ensures #EXT-X-ENDLIST tag is appended for finite VOD streams.
        """
        rewritten_lines: list[str] = []

        for raw_line in content.splitlines():
            line = raw_line.rstrip("\r\n")

            if line and not line.startswith("#"):
                absolute = urllib.parse.urljoin(base_url, line)
                encoded = urllib.parse.quote(absolute, safe="")
                rewritten_lines.append(f"http://{HOST}:{PORT}/proxy-segment?url={encoded}")
                continue

            if (line.startswith("#EXT-X-MAP") or line.startswith("#EXT-X-KEY")) and 'URI="' in line:
                line = self._rewrite_tag_uri_segment(line, base_url)

            rewritten_lines.append(line)

        joined = "\n".join(rewritten_lines)
        has_extinf = any(l.startswith("#EXTINF:") for l in rewritten_lines)
        has_endlist = any(l.strip() == "#EXT-X-ENDLIST" for l in rewritten_lines)
        if has_extinf and not has_endlist:
            joined = joined.rstrip() + "\n#EXT-X-ENDLIST\n"

        return joined

    def _rewrite_m3u8(self, content: str, base_url: str) -> str:
        """Parse original HLS playlist (.m3u8) file and rewrite lines based on semantic content."""
        kind, has_stream_inf, has_media, has_extinf = self._classify_m3u8_text(content)
        if kind == "master":
            return self._rewrite_master_playlist(content, base_url)
        return self._rewrite_media_playlist(content, base_url)

    # =========================================================================
    # MPEG-TS Sync & Demux Utilities
    # =========================================================================

    def _find_ts_sync_offset(self, data: bytes) -> int:
        """Locate MPEG-TS sync byte (0x47) periodic offset within raw segment bytes."""
        if not data or data.startswith(b"\x47"):
            return 0
        max_scan = min(len(data), 8192)
        for offset in range(max_scan):
            if data[offset] != 0x47:
                continue
            hits = 0
            for step in (188, 376, 564):
                pos = offset + step
                if pos < len(data) and data[pos] == 0x47:
                    hits += 1
            if hits >= 2:
                return offset
        return -1

    def _strip_to_ts_payload_if_wrapped(self, data: bytes, target_url: str, content_type: str) -> tuple[bytes, bool]:
        """Strip non-TS wrapper headers (e.g. JPEG/PNG steganography wrappers) before MPEG-TS payload."""
        if not data or data.startswith(b"\x47"):
            return data, False
        lowered_url = (target_url or "").lower()
        lowered_type = (content_type or "").lower()
        should_probe = (
            "/seg" in lowered_url
            or lowered_url.endswith((".ts", ".jpg", ".jpeg"))
            or "mp2t" in lowered_type
            or "octet-stream" in lowered_type
        )
        if not should_probe:
            return data, False
        offset = self._find_ts_sync_offset(data)
        if offset > 0:
            return data[offset:], True
        return data, False

    # =========================================================================
    # Streaming & Subtitle Handlers
    # =========================================================================

    def _handle_stream_proxy(self) -> None:
        """Handle GET `/stream.m3u8` endpoint to proxy and rewrite playlists."""
        stream_snapshot = self._snapshot_stream(include_replay_map=False)
        stream_url = stream_snapshot.get("stream_url")
        if not stream_url:
            self._send_json(404, {"status": "error", "message": "No active stream yet"})
            return

        if stream_snapshot.get("stream_type") == "direct":
            self._handle_direct_stream_proxy()
            return

        try:
            hls_headers = self._build_hls_upstream_headers(stream_url)
            if not hls_headers:
                self._send_json(
                    424,
                    {
                        "status": "error",
                        "message": "Headers for the HLS URL were not found. Capture data is not enough yet.",
                    },
                )
                return

            target_url = stream_url
            is_internally_rewritten = False

            with _CACHE_LOCK:
                if stream_url in _MASTER_TO_MEDIA_CACHE:
                    target_url = _MASTER_TO_MEDIA_CACHE[stream_url]
                    is_internally_rewritten = True

            with self._perform_urlopen(target_url, headers=hls_headers, timeout=20, stream=False) as resp:
                data = resp.read()
                remote_content_type = resp.headers.get("Content-Type", "")

            lowered_content_type = (remote_content_type or "").lower()
            looks_like_playlist = self._payload_looks_m3u8(data)

            if looks_like_playlist:
                try:
                    text = data.decode("utf-8")
                except UnicodeDecodeError:
                    text = data.decode("utf-8", errors="replace")
                playlist_kind, has_stream_inf, has_media, has_extinf = self._classify_m3u8_text(text)

                # INTERNAL REWRITE (Only if no alternate audio/media tracks exist)
                if playlist_kind == "master" and not is_internally_rewritten:
                    if has_media:
                        self._log("DEBUG", "[HLS] Master with #EXT-X-MEDIA detected. Preserving master for audio-video sync.")
                    else:
                        self._log("DEBUG", "[HLS] Master without #EXT-X-MEDIA detected. Attempting internal rewrite to best variant.")
                        best_uri = self._get_best_media_playlist_uri(text)
                        if best_uri:
                            master_base_url = stream_url.rsplit("/", 1)[0] + "/"
                            media_url = urllib.parse.urljoin(master_base_url, best_uri)
                            self._log("DEBUG", f"[HLS] Selected variant: {best_uri}. Rewriting playlist.")
                            with _CACHE_LOCK:
                                if len(_MASTER_TO_MEDIA_CACHE) > 100:
                                    _MASTER_TO_MEDIA_CACHE.clear()
                                _MASTER_TO_MEDIA_CACHE[stream_url] = media_url

                            # Fetch the media playlist internally
                            with self._perform_urlopen(media_url, headers=hls_headers, timeout=20, stream=False) as m_resp:
                                data = m_resp.read()
                                remote_content_type = m_resp.headers.get("Content-Type", "")

                            try:
                                text = data.decode("utf-8")
                            except UnicodeDecodeError:
                                text = data.decode("utf-8", errors="replace")

                            target_url = media_url
                        else:
                            self._log("WARN", "[HLS] No variant found, serving original master.")

                self._log_throttled(
                    f"stream_playlist:{stream_url[:100]}",
                    "DEBUG",
                    "stream proxy playlist | "
                    f"url={stream_url[:140]} | "
                    f"kind={playlist_kind} | "
                    f"stream_inf={has_stream_inf} | "
                    f"media_tag={has_media} | "
                    f"extinf={has_extinf} | "
                    f"upstream_ct={remote_content_type or '-'}",
                    interval_seconds=6,
                )
                base_url = target_url.rsplit("/", 1)[0] + "/"
                text = self._reorder_master_playlist(text)
                rewritten = self._rewrite_m3u8(text, base_url)
                data = rewritten.encode("utf-8")
                remote_content_type = "application/vnd.apple.mpegurl"
            elif not remote_content_type:
                remote_content_type = self._guess_content_type(stream_url)
            elif data.startswith(b"\x47") and "mpegurl" in lowered_content_type:
                remote_content_type = "video/MP2T"

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", remote_content_type)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            # Client (browser/player) closed connection mid-stream.
            return
        except (TimeoutError, socket.timeout):
            self._log_throttled("stream_proxy_timeout", "WARN", "error stream proxy: timed out", interval_seconds=8)
            self._send_json(504, {"status": "error", "message": "Upstream timed out while fetching the main stream"})
        except URLError as exc:
            self._log("WARN", f"failed to fetch main stream: {exc}")
            self._send_json(502, {"status": "error", "message": "Failed to fetch the main stream"})
        except Exception as exc:
            if "timed out" in str(exc).lower():
                self._log_throttled("stream_proxy_timeout", "WARN", "error stream proxy: timed out", interval_seconds=8)
                self._send_json(504, {"status": "error", "message": "Upstream timed out while fetching the main stream"})
                return
            self._log("ERROR", f"error stream proxy: {exc}")
            self._send_json(500, {"status": "error", "message": "Internal error"})

    def _handle_direct_stream_proxy(self) -> None:
        """Handle streaming of direct video files (.mp4, .webm, .mkv)."""
        stream_snapshot = self._snapshot_stream(include_replay_map=False)
        stream_url = stream_snapshot.get("stream_url")
        if not stream_url:
            self._send_json(404, {"status": "error", "message": "No active stream yet"})
            return

        if stream_snapshot.get("stream_type") != "direct":
            self._send_json(
                400,
                {
                    "status": "error",
                    "message": "Active stream is not a direct stream. Use /stream.m3u8 for HLS.",
                },
            )
            return

        try:
            forwarded = self._build_direct_upstream_headers()
            is_local = "localhost" in stream_url or "127.0.0.1" in stream_url
            bypass_cffi = is_local or stream_snapshot.get("stream_type") == "direct"

            with self._perform_urlopen(stream_url, headers=forwarded, timeout=60, stream=True, bypass_cffi=bypass_cffi) as resp:
                self._stream_to_client(resp, self._guess_content_type(stream_url))
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            return
        except HTTPError as exc:
            # Forward status/headers/body so the player receives the original upstream response.
            try:
                self._stream_to_client(exc, self._guess_content_type(stream_url))
            except Exception:
                self._send_json(exc.code or 502, {"status": "error", "message": f"Upstream error {exc.code}"})
        except URLError as exc:
            self._log("ERROR", f"direct relay failed: {exc}")
            self._send_json(502, {"status": "error", "message": "Failed to fetch direct stream"})
        except Exception as exc:
            self._log("ERROR", f"error direct relay: {exc}")
            self._send_json(500, {"status": "error", "message": "Internal error"})

    def _handle_subtitle_proxy(self) -> None:
        """Handle GET `/proxy-subtitle` endpoint to relay upstream WebVTT/SRT subtitles."""
        stream_snapshot = self._snapshot_stream(include_replay_map=False)
        subtitle_url = stream_snapshot.get("subtitle_url")
        if not subtitle_url:
            self._send_json(404, {"status": "error", "message": "Subtitle is not available yet"})
            return

        try:
            with self._perform_urlopen(subtitle_url, headers={}, timeout=20) as resp:
                data = resp.read()
                content_type = resp.headers.get("Content-Type", "") or self._guess_content_type(subtitle_url)

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            return
        except URLError as exc:
            self._log("ERROR", f"failed to fetch subtitle: {exc}")
            self._send_json(502, {"status": "error", "message": "Failed to fetch subtitle"})
        except Exception as exc:
            self._log("ERROR", f"error subtitle proxy: {exc}")
            self._send_json(500, {"status": "error", "message": "Internal error"})

    def _handle_set_subtitle(self) -> None:
        """Handle POST `/set-subtitle` endpoint to pin or update active subtitles."""
        try:
            data = self._read_json_body()
        except Exception as exc:
            self._send_json(400, {"status": "error", "message": str(exc)})
            return

        subtitle_url = str(data.get("subtitle_url") or "").strip()
        srt_content = str(data.get("srt_content") or "")
        filename = str(data.get("filename") or "").strip() or "subtitle.srt"
        incoming_title = str(data.get("title") or "").strip()
        incoming_ep = data.get("episode")

        with STATE_LOCK:
            # Stale async check: if caller provided title/episode, verify current stream still matches
            if incoming_title:
                curr_title = str(current_stream.get("title") or "").strip()
                if curr_title and curr_title.lower() != incoming_title.lower():
                    self._log("WARN", f"set-subtitle rejected (stale title) | incoming={incoming_title!r} | current={curr_title!r}")
                    self._send_json(409, {"status": "error", "message": "Active stream title changed during fetch"})
                    return
            if incoming_ep is not None and isinstance(incoming_ep, int):
                curr_ep = current_stream.get("episode")
                if curr_ep is not None and curr_ep != incoming_ep:
                    self._log("WARN", f"set-subtitle rejected (stale episode) | incoming={incoming_ep} | current={curr_ep}")
                    self._send_json(409, {"status": "error", "message": "Active stream episode changed during fetch"})
                    return

            current_stream["subtitle_url"] = subtitle_url
            current_stream["subtitle_filename"] = filename
            current_stream["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            srt_store["content"] = srt_content
            srt_store["filename"] = filename

        self._log("INFO", f"subtitle set | filename={filename} | len={len(srt_content)}")
        self._send_json(200, {"status": "ok"})

    def _handle_proxy_subtitle_srt(self) -> None:
        """Handle GET `/proxy-subtitle-srt` endpoint to serve in-memory decoded SRT."""
        with STATE_LOCK:
            has_sub_url = bool(current_stream.get("subtitle_url"))
            content = str(srt_store.get("content") or "")
        if not has_sub_url or not content:
            self._send_json(404, {"status": "error", "message": "SRT is not available yet"})
            return

        body = content.encode("utf-8", errors="replace")
        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Content-Type", "text/srt; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _handle_segment_proxy(self) -> None:
        """
        Handle GET `/proxy-segment?url=...` endpoint.

        Proxies HLS segment files (.ts, .m4s) or sub-playlists from upstream CDNs.
        Workflow:
        1. Extract target URL from query parameters.
        2. Rebuild request headers (inserting original Cookie, Referer, User-Agent matching target CDN).
        3. Limit segment request concurrency using Semaphore (`_SEGMENT_PROXY_SEMAPHORE` max 6)
           to prevent user IP throttling/blocking by CDN.
        4. Implement Auto-Retry mechanism if target CDN returns 5xx error codes
           (e.g., Cloudflare 521 Web Server Is Down) with exponential backoff delay.
        5. Forward raw segment bytes back to local browser player with open CORS headers.
        """
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        target_url = params.get("url", [""])[0]

        if not self._is_valid_http_url(target_url):
            self._send_json(400, {"status": "error", "message": "url parameter is invalid"})
            return

        _SEGMENT_PROXY_SEMAPHORE.acquire()
        try:
            hls_headers = self._build_hls_upstream_headers(target_url)
            if not hls_headers:
                self._send_json(
                    424,
                    {
                        "status": "error",
                        "message": "Headers for the target segment/playlist were not found.",
                    },
                )
                return
            data = b""
            content_type = self._guess_content_type(target_url)
            fetched = False

            last_521_exc = None

            retryable_http_codes = {429, 500, 502, 503, 504, 520, 521, 522, 523, 524}
            # Brief retries for intermittent upstream 5xx errors.
            max_attempts = max(SEGMENT_521_RETRY_ATTEMPTS, SEGMENT_TRANSIENT_RETRY_ATTEMPTS)
            # Give 429 more attempts to survive long cooldowns
            max_attempts = max(max_attempts, 5)
            last_exc = None
            for attempt in range(1, max_attempts + 1):
                try:
                    wait_if_host_paused(target_url)
                    with self._perform_urlopen(target_url, headers=hls_headers, timeout=45, stream=False) as resp:
                        data = resp.read()
                        content_type = resp.headers.get("Content-Type", "") or content_type
                        fetched = True
                    break
                except HTTPError as exc:
                    code = int(getattr(exc, "code", 0) or 0)
                    if code == 403:
                        # 1-shot clean-header retry: remove foreign cookies/referer and retry once immediately
                        if attempt == 1 and ("cookie" in hls_headers or "referer" in hls_headers or "origin" in hls_headers):
                            clean_headers = {
                                k: v
                                for k, v in hls_headers.items()
                                if k.lower() in {"user-agent", "range", "accept", "accept-encoding", "accept-language"}
                            }
                            try:
                                with self._perform_urlopen(target_url, headers=clean_headers, timeout=20, stream=False) as c_resp:
                                    data = c_resp.read()
                                    content_type = c_resp.headers.get("Content-Type", "") or content_type
                                    fetched = True
                                    self._log("INFO", f"[SEGMENT] recovered from HTTP 403 via clean headers | target={target_url[:100]}")
                                    break
                            except Exception as clean_exc:
                                self._log("WARN", f"[SEGMENT] clean header retry failed for 403: {clean_exc} | target={target_url[:100]}")
                        raise
                    if code not in retryable_http_codes:
                        raise
                    last_exc = exc
                    if code == 521:
                        last_521_exc = exc

                    if code == 429:
                        raw_retry = exc.headers.get("Retry-After", "10")
                        try:
                            retry_val = int(raw_retry)
                        except ValueError:
                            retry_val = 10
                        set_host_pause(target_url, float(retry_val))
                        self._log_throttled(
                            "segment_429_retry",
                            "WARN",
                            f"upstream HTTP 429, pausing host for {retry_val}s | target={target_url[:120]}",
                            interval_seconds=2,
                        )
                        # We don't sleep here because the next loop will call wait_if_host_paused
                        continue

                    if attempt < SEGMENT_TRANSIENT_RETRY_ATTEMPTS:
                        self._log_throttled(
                            "segment_http_retry",
                            "WARN",
                            (
                                f"upstream HTTP {code}, retry segment {attempt}/{SEGMENT_TRANSIENT_RETRY_ATTEMPTS - 1} "
                                f"| target={target_url[:120]}"
                            ),
                            interval_seconds=2,
                        )
                        base_delay = SEGMENT_521_RETRY_DELAY_SEC if code == 521 else SEGMENT_TRANSIENT_RETRY_DELAY_SEC
                        time.sleep(base_delay * attempt + random.uniform(0.1, 0.5))
                        continue
                    raise
                except http.IncompleteRead as exc:
                    last_exc = exc
                    if attempt < SEGMENT_TRANSIENT_RETRY_ATTEMPTS:
                        self._log_throttled(
                            "segment_incomplete_retry",
                            "WARN",
                            (
                                f"incomplete read segment, retry {attempt}/{SEGMENT_TRANSIENT_RETRY_ATTEMPTS - 1} "
                                f"| target={target_url[:120]}"
                            ),
                            interval_seconds=2,
                        )
                        time.sleep(SEGMENT_TRANSIENT_RETRY_DELAY_SEC * attempt)
                        continue
                    raise
                except (URLError, TimeoutError, socket.timeout, ConnectionResetError) as exc:
                    last_exc = exc
                    if attempt < SEGMENT_TRANSIENT_RETRY_ATTEMPTS:
                        self._log_throttled(
                            "segment_transient_retry",
                            "WARN",
                            (
                                f"transient error segment, retry {attempt}/{SEGMENT_TRANSIENT_RETRY_ATTEMPTS - 1} "
                                f"| err={type(exc).__name__}"
                            ),
                            interval_seconds=2,
                        )
                        time.sleep(SEGMENT_TRANSIENT_RETRY_DELAY_SEC * attempt)
                        continue
                    raise

            # Fallback: try once more with basic identity headers, without URL-specific map data.
            if not fetched and last_521_exc is not None:
                try:
                    with self._perform_urlopen(target_url, headers={}, timeout=45) as resp:
                        data = resp.read()
                        content_type = resp.headers.get("Content-Type", "") or content_type
                        fetched = True
                        self._log_throttled(
                            "segment_521_fallback_ok",
                            "WARN",
                            f"upstream 521 recovered via basic fallback headers | target={target_url[:120]}",
                            interval_seconds=4,
                        )
                except HTTPError as exc:
                    if int(getattr(exc, "code", 0) or 0) == 521:
                        self._trigger_segment_resync("upstream HTTP 521 persisted", target_url)
                    raise

            if not fetched and last_521_exc is not None:
                self._trigger_segment_resync("upstream HTTP 521 persisted", target_url)
                raise last_521_exc
            if not fetched and last_exc is not None:
                if isinstance(last_exc, http.IncompleteRead):
                    self._trigger_segment_resync("IncompleteRead persisted", target_url)
                elif isinstance(last_exc, HTTPError):
                    self._trigger_segment_resync(f"upstream HTTP {getattr(last_exc, 'code', '?')} persisted", target_url)
                raise last_exc

            payload_looks_playlist = self._payload_looks_m3u8(data)
            if payload_looks_playlist:
                try:
                    text = data.decode("utf-8")
                except UnicodeDecodeError:
                    text = data.decode("utf-8", errors="replace")
                if ".m3u8" in target_url.lower() or text.lstrip().startswith("#EXTM3U"):
                    playlist_kind, has_stream_inf, has_media, has_extinf = self._classify_m3u8_text(text)
                    self._log_throttled(
                        f"segment_playlist:{target_url[:100]}",
                        "DEBUG",
                        "stream proxy playlist | "
                        f"url={target_url[:140]} | "
                        f"kind={playlist_kind} | "
                        f"stream_inf={has_stream_inf} | "
                        f"media_tag={has_media} | "
                        f"extinf={has_extinf} | "
                        f"upstream_ct={content_type or '-'}",
                        interval_seconds=6,
                    )
                base_url = target_url.rsplit("/", 1)[0] + "/"
                text = self._reorder_master_playlist(text)
                text = self._rewrite_m3u8(text, base_url)
                data = text.encode("utf-8")
                content_type = "application/vnd.apple.mpegurl"
            elif ".m3u8" in target_url.lower():
                self._log_throttled(
                    f"segment_playlist_binary:{target_url[:100]}",
                    "WARN",
                    "segment proxy m3u8 returned binary | "
                    f"target={target_url[:140]} | "
                    f"upstream_ct={content_type or '-'} | "
                    f"first_bytes={data[:8].hex()}",
                    interval_seconds=6,
                )
                if data.startswith(b"\x47"):
                    content_type = "video/MP2T"

            data, stripped_ts_wrapper = self._strip_to_ts_payload_if_wrapped(data, target_url, content_type)
            if stripped_ts_wrapper:
                content_type = "video/MP2T"
                self._log_throttled(
                    f"segment_ts_wrapper:{target_url[:100]}",
                    "DEBUG",
                    f"stripped non-TS wrapper before MPEG-TS payload | target={target_url[:140]}",
                    interval_seconds=8,
                )

            if not stripped_ts_wrapper and data.startswith(b"\x89PNG\r\n\x1a\n"):
                iend_idx = data.find(b"IEND")
                if iend_idx != -1:
                    data = data[iend_idx + 8:]
                    guessed = self._guess_content_type(target_url)
                    if guessed and guessed != "application/octet-stream":
                        content_type = guessed
                    else:
                        content_type = "video/MP2T"

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "max-age=3600")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            # Common when the player changes bitrate, seeks, or stops.
            return
        except (TimeoutError, socket.timeout):
            self._log_throttled("segment_proxy_timeout", "WARN", "error segment proxy: timed out", interval_seconds=8)
            self._send_json(504, {"status": "error", "message": "Upstream timed out while fetching segment"})
        except HTTPError as exc:
            err_code = int(getattr(exc, "code", 0) or 0)
            if err_code == 521:
                self._log(
                    "WARN",
                    f"segment proxy failed: upstream HTTP 521 (after retry/fallback) | target={target_url[:120]}",
                )
                self._send_json(503, {"status": "error", "message": "Upstream 521 (origin down/blocked). Please sync again."})
                return
            self._log("WARN", f"[SEGMENT] upstream HTTP {err_code}: {exc} | target={target_url[:120]}")
            self._send_json(err_code if err_code >= 400 else 502, {"status": "error", "message": f"Upstream error HTTP {err_code or 'error'}"})
        except http.IncompleteRead as exc:
            self._trigger_segment_resync("IncompleteRead", target_url)
            got = len(getattr(exc, "partial", b"") or b"")
            self._log(
                "WARN",
                f"segment proxy failed: IncompleteRead ({got} bytes partial) | target={target_url[:120]}",
            )
            self._send_json(502, {"status": "error", "message": "Upstream segment was truncated (IncompleteRead). Try proxying again."})
        except URLError as exc:
            if "521" in str(exc):
                self._trigger_segment_resync("URLError 521", target_url)
            self._log("WARN", f"segment proxy failed: {exc}")
            self._send_json(502, {"status": "error", "message": "Failed to fetch segment"})
        except Exception as exc:
            if "timed out" in str(exc).lower():
                self._log_throttled("segment_proxy_timeout", "WARN", "error segment proxy: timed out", interval_seconds=8)
                self._send_json(504, {"status": "error", "message": "Upstream timed out while fetching segment"})
                return
            self._log("ERROR", f"error segment proxy: {exc}")
            self._send_json(500, {"status": "error", "message": "Internal error"})
        finally:
            _SEGMENT_PROXY_SEMAPHORE.release()



