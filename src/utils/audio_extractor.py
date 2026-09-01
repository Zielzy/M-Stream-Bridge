# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     __VERSION__
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
"""
Asynchronous Audio Extraction Engine for Direct Media & HLS Streams.
"""

from __future__ import annotations

import io
import logging
import os
from pathlib import Path
import random
import re
import subprocess
import threading
import time
from typing import Any
import urllib.parse

from curl_cffi import requests as cffi_requests

from core.config import get_config_path
from core.state import is_host_paused, set_host_pause, wait_if_host_paused
from utils.ffmpeg_downloader import get_ffmpeg_path, is_ffmpeg_installed

logger = logging.getLogger("mstream_bridge")

_extract_process: subprocess.Popen[bytes] | None = None
_extract_lock: threading.Lock = threading.Lock()
_extract_status: str = "idle"
_extract_percent: int = 0
_extract_error: str = ""


# =============================================================================
# Extraction Status & Path Resolvers
# =============================================================================

def get_audio_temp_path() -> Path:
    """Return local filesystem path to extracted audio container."""
    temp_dir = get_config_path().parent / "temp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    return temp_dir / "m-stream_bridge.mp4"


def get_extraction_status() -> dict[str, Any]:
    """Retrieve current extraction status snapshot."""
    global _extract_status, _extract_percent, _extract_error
    return {
        "status": _extract_status,
        "percent": _extract_percent,
        "error": _extract_error,
    }


def cancel_extraction() -> None:
    """Terminate in-progress FFmpeg extraction process and reset state."""
    global _extract_process, _extract_status, _extract_percent
    with _extract_lock:
        if _extract_process:
            try:
                _extract_process.terminate()
                _extract_process.wait(timeout=2)
            except Exception:
                pass
            _extract_process = None
        _extract_status = "idle"
        _extract_percent = 0


def start_extraction_async(url: str, headers: dict[str, str] | None = None, stream_type: str = "hls") -> None:
    """Launch asynchronous audio extraction thread for active media stream."""
    global _extract_status, _extract_percent, _extract_error

    with _extract_lock:
        if _extract_status == "extracting":
            return

        _extract_status = "extracting"
        _extract_percent = 0
        _extract_error = ""

    threading.Thread(target=_extract_worker, args=(url, headers, stream_type), daemon=True, name="AudioExtractor").start()


# =============================================================================
# MPEG-TS Sync Offset & Payload Probe Helpers
# =============================================================================

def _find_ts_sync_offset(data: bytes) -> int:
    """Locate 0x47 sync byte boundary offset in MPEG-TS data payload."""
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


def _strip_to_ts_payload_if_wrapped(data: bytes, target_url: str, content_type: str) -> bytes:
    """Strip wrapper bytes from segment payload if detected as wrapped MPEG-TS."""
    if not data or data.startswith(b"\x47"):
        return data
    lowered_url = (target_url or "").lower()
    lowered_type = (content_type or "").lower()
    should_probe = (
        "/seg" in lowered_url
        or lowered_url.endswith((".ts", ".jpg", ".jpeg"))
        or "mp2t" in lowered_type
        or "octet-stream" in lowered_type
    )
    if not should_probe:
        return data
    offset = _find_ts_sync_offset(data)
    if offset > 0:
        return data[offset:]
    return data


# =============================================================================
# Adaptive Concurrency Controller
# =============================================================================

class ConcurrencyController:
    """AIMD (Additive Increase / Multiplicative Decrease) dynamic concurrency manager."""

    def __init__(self, start_workers: int = 4, max_workers: int = 16, min_workers: int = 2) -> None:
        self.lock: threading.Lock = threading.Lock()
        self.target_workers: int = start_workers
        self.absolute_max: int = max_workers
        self.safe_max: int = max_workers
        self.min_workers: int = min_workers
        self.active_workers: int = 0
        self.consecutive_success: int = 0

        self.PENALTY_COOLDOWN: float = 1.5
        self.last_penalty_time: float = 0.0

    def register_result(self, latency: float, status_code: int, retry_after: int = 0, url: str | None = None) -> None:
        """Register download attempt outcome to adapt concurrency dynamically."""
        with self.lock:
            now = time.time()
            in_cooldown = (now - self.last_penalty_time) < self.PENALTY_COOLDOWN

            if status_code == 429:
                self.consecutive_success = 0

                if retry_after > 0 and url:
                    set_host_pause(url, retry_after)

                if in_cooldown:
                    return

                # Learning: update safe ceiling
                self.safe_max = max(self.min_workers, self.target_workers - 2)

                new_target = max(self.min_workers, self.target_workers - 4)
                if new_target < self.target_workers:
                    logger.warning(
                        "[Controller] HTTP 429 hit! Safe ceiling adjusted to %s. Scaling down %s -> %s workers",
                        self.safe_max,
                        self.target_workers,
                        new_target,
                    )
                    self.target_workers = new_target

                self.last_penalty_time = now

            elif status_code == 200:
                if in_cooldown or (url and is_host_paused(url)):
                    return

                self.consecutive_success += 1

                if latency > 3.0:
                    new_target = max(self.min_workers, self.target_workers - 2)
                    if new_target < self.target_workers:
                        logger.warning(
                            "[Controller] High Latency (%.2fs). Scaling down %s -> %s workers",
                            latency,
                            self.target_workers,
                            new_target,
                        )
                        self.target_workers = new_target
                        self.consecutive_success = 0
                        return

                if self.consecutive_success >= 10:
                    new_target = min(self.safe_max, self.target_workers + 2)
                    if new_target > self.target_workers:
                        logger.info(
                            "[Controller] Stable performance. Scaling up %s -> %s workers (Max: %s)",
                            self.target_workers,
                            new_target,
                            self.safe_max,
                        )
                        self.target_workers = new_target
                    self.consecutive_success = 0


def _download_segment_once(
    index: int,
    url: str,
    headers: dict[str, str] | None,
    cffi_session: cffi_requests.Session,
    timeout: int = 30,
) -> tuple[int, int, bytes | None, str | None]:
    """Attempt exactly one download. Returns (status_code, retry_after, data, error)."""
    try:
        resp = cffi_session.get(url, headers=headers, timeout=timeout)
        if resp.status_code == 200:
            content_type = str(resp.headers.get("Content-Type", ""))
            data = _strip_to_ts_payload_if_wrapped(resp.content, url, content_type)
            return 200, 0, data, None
        elif resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", 0))
            return 429, retry_after, None, "HTTP 429"
        else:
            return resp.status_code, 0, None, f"HTTP {resp.status_code}"
    except Exception as e:
        return 0, 0, None, str(e)


# =============================================================================
# Direct Stream Extraction (FFmpeg)
# =============================================================================

def _extract_worker(url: str, headers: dict[str, str] | None, stream_type: str) -> None:
    """Top-level extraction dispatcher routing to direct or HLS extraction pipeline."""
    global _extract_process, _extract_status, _extract_percent, _extract_error

    try:
        if not is_ffmpeg_installed():
            raise Exception("FFmpeg is not installed yet")

        temp_dir = get_config_path().parent / "temp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        out_path = temp_dir / "m-stream_bridge.mp4"

        if out_path.exists():
            try:
                os.remove(out_path)
            except Exception:
                pass

        if stream_type in ("direct", "http", "file"):
            _extract_direct(url, headers, out_path)
        else:
            _extract_hls(url, headers, out_path)

    except Exception as e:
        with _extract_lock:
            if _extract_status == "extracting":
                _extract_status = "error"
                _extract_error = str(e)
                logger.error("[AUDIO ERROR] Exception: %s", _extract_error)
    finally:
        with _extract_lock:
            _extract_process = None


def _extract_direct(url: str, headers: dict[str, str] | None, out_path: Path) -> None:
    """Extract audio from direct HTTP/MP4 video stream using native FFmpeg process."""
    global _extract_process, _extract_status, _extract_percent, _extract_error

    logger.info("[AUDIO] Starting native FFmpeg extraction for direct stream: %s", url)
    if headers:
        logger.info("[AUDIO] Captured headers keys: %s", list(headers.keys()))
    else:
        logger.info("[AUDIO] Captured headers keys: NONE")

    header_str = ""
    user_agent = None
    if headers:
        skip_headers = {
            "connection", "keep-alive", "transfer-encoding", "te",
            "trailer", "upgrade", "proxy-connection", "range", "host",
        }
        for k, v in headers.items():
            if k.lower() == "user-agent":
                user_agent = v
            elif k.lower() not in skip_headers:
                header_str += f"{k}: {v}\r\n"

    if not user_agent:
        user_agent = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
        )

    cmd = [
        str(get_ffmpeg_path()),
        "-y",
        "-loglevel", "debug",
        "-user_agent", user_agent,
    ]
    if header_str:
        cmd.extend(["-headers", header_str])

    cmd.extend([
        "-i", url,
        "-map", "0:a:0?",
        "-vn",
        "-acodec", "copy",
        str(out_path),
    ])

    with _extract_lock:
        if _extract_status != "extracting":
            return
        _extract_process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )

    # Read FFmpeg logs
    last_lines: list[str] = []
    text_stdout = io.TextIOWrapper(_extract_process.stdout, encoding="utf-8", errors="replace")
    try:
        for line in text_stdout:
            last_lines.append(line.strip())
            if len(last_lines) > 50:
                last_lines.pop(0)
    except Exception:
        pass

    _extract_process.wait()
    returncode = _extract_process.returncode

    with _extract_lock:
        if _extract_status != "extracting":
            return

        if returncode == 0 and out_path.exists():
            _extract_status = "done"
            _extract_percent = 100
            logger.info("[AUDIO] Extraction complete! Output: %s", out_path)
        else:
            _extract_status = "error"
            log_snippet = "\n".join(last_lines)
            _extract_error = f"FFmpeg failed with code {returncode}. Log: {log_snippet}"
            logger.error("[FFMPEG ERROR] %s", _extract_error)


# =============================================================================
# HLS Playlist & Segment Extraction Pipeline
# =============================================================================

def _extract_hls(url: str, headers: dict[str, str] | None, out_path: Path) -> None:
    """Download HLS segments with adaptive concurrency and stream to FFmpeg stdin pipe."""
    global _extract_process, _extract_status, _extract_percent, _extract_error

    cffi_session = cffi_requests.Session(impersonate="chrome")

    # Phase 1: Fetch the original playlist directly from CDN
    logger.info("[AUDIO] Fetching playlist directly from CDN...")
    resp = cffi_session.get(url, headers=headers, timeout=30)
    playlist_text = resp.content.decode("utf-8", errors="replace")

    lines = playlist_text.splitlines()

    target_playlist_url = url
    has_audio_rendition = False

    # Phase 1.5: Audio Rendition Detection
    for line in lines:
        if line.startswith("#EXT-X-MEDIA:TYPE=AUDIO"):
            match = re.search(r'URI="([^"]+)"', line)
            if match:
                target_playlist_url = match.group(1)
                if not target_playlist_url.startswith("http"):
                    target_playlist_url = urllib.parse.urljoin(url, target_playlist_url)
                has_audio_rendition = True
                logger.info("[AUDIO] Detected separate audio rendition! URL: %s", target_playlist_url)
                break

    # If no audio rendition, fallback to lowest bandwidth video stream
    if not has_audio_rendition and any(line.startswith("#EXT-X-STREAM-INF") for line in lines):
        variants: list[tuple[int, str]] = []
        for i, line in enumerate(lines):
            if line.startswith("#EXT-X-STREAM-INF"):
                bw = 9999999
                match = re.search(r"BANDWIDTH=(\d+)", line)
                if match:
                    bw = int(match.group(1))

                next_line = lines[i + 1].strip() if i + 1 < len(lines) else ""
                if next_line and not next_line.startswith("#"):
                    variants.append((bw, next_line))

        if variants:
            variants.sort(key=lambda x: x[0])
            target_playlist_url = variants[0][1]
            if not target_playlist_url.startswith("http"):
                target_playlist_url = urllib.parse.urljoin(url, target_playlist_url)
            logger.info("[AUDIO] No separate audio. Falling back to lowest bandwidth video variant.")

    logger.info("[AUDIO] FFmpeg extracting directly from: %s", target_playlist_url)

    # Phase 2: Parse segment URLs
    resp = cffi_session.get(target_playlist_url, headers=headers, timeout=30)
    playlist_text = resp.content.decode("utf-8", errors="replace")
    lines = playlist_text.splitlines()

    segment_urls: list[str] = []
    for line in lines:
        line = line.strip()
        if line.startswith("#EXT-X-MAP:"):
            match = re.search(r'URI="([^"]+)"', line)
            if match:
                init_url = match.group(1)
                if not init_url.startswith("http"):
                    init_url = urllib.parse.urljoin(target_playlist_url, init_url)
                segment_urls.insert(0, init_url)
        elif line and not line.startswith("#"):
            if not line.startswith("http"):
                line = urllib.parse.urljoin(target_playlist_url, line)
            segment_urls.append(line)

    if not segment_urls:
        raise Exception("No video segments found in the playlist")

    total_segments = len(segment_urls)
    logger.info("[AUDIO] Found %s segments. Starting parallel stream to FFmpeg...", total_segments)

    # Phase 3: Setup FFmpeg Pipe
    cmd = [
        str(get_ffmpeg_path()),
        "-y",
        "-i", "pipe:0",
        "-vn",
        "-acodec", "copy",
        str(out_path),
    ]

    with _extract_lock:
        if _extract_status != "extracting":
            return
        _extract_process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )

    # Phase 4: Parallel download & sequential pipe
    completed = 0
    import queue

    q: queue.Queue[tuple[int, str]] = queue.Queue()
    for idx, seg_url in enumerate(segment_urls):
        q.put((idx, seg_url))

    segment_buffer: dict[int, bytes] = {}
    next_idx_to_write = 0
    write_lock = threading.Lock()
    error_event = threading.Event()

    last_lines: list[str] = []

    def _ffmpeg_reader() -> None:
        if not _extract_process or not _extract_process.stdout:
            return
        text_stdout = io.TextIOWrapper(_extract_process.stdout, encoding="utf-8", errors="replace")
        try:
            for line in text_stdout:
                last_lines.append(line.strip())
                if len(last_lines) > 10:
                    last_lines.pop(0)
        except Exception:
            pass

    t_reader = threading.Thread(target=_ffmpeg_reader, daemon=True, name="FFmpegReader")
    t_reader.start()

    controller = ConcurrencyController(start_workers=4, max_workers=16, min_workers=2)

    def _dl_worker() -> None:
        nonlocal completed, next_idx_to_write
        global _extract_status, _extract_percent, _extract_error
        while True:
            with _extract_lock:
                if _extract_status != "extracting":
                    break
            if error_event.is_set():
                break

            # Backpressure: don't download if buffer is too big (prevent RAM spike)
            while len(segment_buffer) > 30 and not error_event.is_set():
                time.sleep(0.1)
            if error_event.is_set():
                break

            with controller.lock:
                if controller.active_workers >= controller.target_workers:
                    allowed = False
                else:
                    controller.active_workers += 1
                    allowed = True

            if not allowed:
                time.sleep(0.1)
                continue

            try:
                idx, seg_url = q.get_nowait()
            except queue.Empty:
                with controller.lock:
                    controller.active_workers -= 1
                break

            max_retries = 10
            success = False
            last_delay = 0.0
            for attempt in range(1, max_retries + 1):
                if error_event.is_set():
                    break

                wait_if_host_paused(seg_url)

                start_t = time.time()
                status, retry_after, data, err = _download_segment_once(idx, seg_url, headers, cffi_session)
                latency = time.time() - start_t

                controller.register_result(latency, status, retry_after, seg_url)

                if status == 200 and data is not None:
                    success = True
                    break

                if attempt < max_retries:
                    if status == 429:
                        if retry_after > 0:
                            delay = float(retry_after)
                        else:
                            delay = max(last_delay * 2, 2.0 * attempt) if last_delay > 0 else (2.0 * attempt)
                    else:
                        delay = max(last_delay * 2, 2.0 * attempt) if last_delay > 0 else (2.0 * attempt)

                    last_delay = delay
                    actual_delay = delay + random.uniform(0.2, 2.5)
                    logger.warning(
                        "[AUDIO] Segment %s attempt %s/%s failed (%s). Retrying in %.2fs...",
                        idx,
                        attempt,
                        max_retries,
                        err,
                        actual_delay,
                    )
                    time.sleep(actual_delay)

            if not success and not error_event.is_set():
                with _extract_lock:
                    if _extract_status == "extracting":
                        _extract_status = "error"
                        _extract_error = f"Segment {idx} failed after {max_retries} attempts: {err}"
                        error_event.set()
            elif success and data is not None:
                with write_lock:
                    segment_buffer[idx] = data
                    while next_idx_to_write in segment_buffer:
                        chunk_data = segment_buffer.pop(next_idx_to_write)
                        if _extract_process and _extract_process.stdin and _extract_process.poll() is None:
                            try:
                                _extract_process.stdin.write(chunk_data)
                                _extract_process.stdin.flush()
                            except Exception as e:
                                logger.warning("[FFMPEG] Broken pipe: %s", e)
                                error_event.set()
                        next_idx_to_write += 1

                with _extract_lock:
                    if _extract_status == "extracting":
                        completed += 1
                        _extract_percent = int((completed / total_segments) * 95)
                        if completed % max(1, total_segments // 10) == 0 or completed == total_segments:
                            logger.info(
                                "[AUDIO] Streamed %s/%s segments (%s%%) | Workers: %s",
                                completed,
                                total_segments,
                                _extract_percent,
                                controller.target_workers,
                            )

            with controller.lock:
                controller.active_workers -= 1

    threads: list[threading.Thread] = []
    for _ in range(16):
        t = threading.Thread(target=_dl_worker, daemon=True, name="HLSWorker")
        t.start()
        threads.append(t)

    while any(t.is_alive() for t in threads):
        with _extract_lock:
            if _extract_status != "extracting":
                break
        time.sleep(0.2)

    with _extract_lock:
        if _extract_status == "error":
            raise Exception(_extract_error)
        if _extract_status != "extracting":
            return

    # Close stdin to signal EOF to FFmpeg
    try:
        if _extract_process and _extract_process.stdin:
            _extract_process.stdin.close()
    except Exception:
        pass

    if _extract_process:
        _extract_process.wait()
        returncode = _extract_process.returncode
    else:
        returncode = -1

    with _extract_lock:
        if _extract_status != "extracting":
            return

        if returncode == 0 and out_path.exists():
            _extract_status = "done"
            _extract_percent = 100
            logger.info("[AUDIO] Extraction complete! Output: %s", out_path)
        else:
            _extract_status = "error"
            log_snippet = "\n".join(last_lines)
            _extract_error = f"FFmpeg failed with code {returncode}. Log: {log_snippet}"
            logger.error("[FFMPEG ERROR] %s", _extract_error)
