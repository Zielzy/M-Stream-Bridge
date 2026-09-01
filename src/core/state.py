# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     __VERSION__
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
"""
Global in-memory state definitions, concurrency locks, and stream metadata models.
"""

from __future__ import annotations

import os
import random
import threading
import time
from typing import Any
from urllib.parse import urlparse

# =============================================================================
# Network & Server Constants
# =============================================================================

HOST: str = os.environ.get("BRIDGE_HOST", "127.0.0.1")
PORT: int = int(os.environ.get("BRIDGE_PORT", "7000"))
MAX_BODY_BYTES: int = 10 * 1024 * 1024

LOG_PREFIX: str = "[BRIDGE]"
LOG_LEVEL: str = (os.environ.get("BRIDGE_LOG_LEVEL") or "INFO").strip().upper()

MAX_URL_HEADER_MAP: int = int(os.environ.get("BRIDGE_MAX_HEADER_MAP", "600"))
MAX_URL_HEADER_MAP_PER_HOST: int = int(os.environ.get("BRIDGE_MAX_HEADER_MAP_PER_HOST", "200"))
MAX_CAPTURE_CANDIDATES: int = 100
MAX_MANUAL_SUBTITLE_CANDIDATES: int = 200
MAX_CAPTURE_TAB_META: int = 200
CAPTURE_TAB_META_TTL_SEC: int = 30 * 60

SEGMENT_521_RETRY_ATTEMPTS: int = max(1, int(os.environ.get("BRIDGE_SEGMENT_521_RETRY_ATTEMPTS", "3")))
SEGMENT_521_RETRY_DELAY_SEC: float = max(0.05, float(os.environ.get("BRIDGE_SEGMENT_521_RETRY_DELAY_SEC", "0.35")))
SEGMENT_TRANSIENT_RETRY_ATTEMPTS: int = max(1, int(os.environ.get("BRIDGE_SEGMENT_TRANSIENT_RETRY_ATTEMPTS", "3")))
SEGMENT_TRANSIENT_RETRY_DELAY_SEC: float = max(0.05, float(os.environ.get("BRIDGE_SEGMENT_TRANSIENT_RETRY_DELAY_SEC", "0.30")))


# =============================================================================
# Stream State Models & Stores
# =============================================================================

def get_initial_stream_state() -> dict[str, Any]:
    """Return a pristine default stream metadata dictionary."""
    return {
        "stream_url": None,
        "stream_type": "hls",
        "m3u8_url": None,
        "episode": None,
        "season": None,
        "detected_episode": None,
        "referer": "",
        "page_url": "",
        "cookie": "",
        "user_agent": "",
        "origin": "",
        "request_headers": {},
        "url_header_map": {},
        "hls_master_url": "",
        "subtitle_url": "",
        "subtitle_filename": "",
        "title": "Untitled Stream",
        "display_title": "",
        "title_candidates": [],
        "updated_at": None,
        "content_type": "",
        "title_source": "",
        "title_updated_at": 0.0,
    }


current_stream: dict[str, Any] = get_initial_stream_state()

capture_tab_meta: dict[int, dict[str, Any]] = {}
capture_active_state: dict[str, Any] = {"score": 0, "url_key": "", "tab_id": -1, "updated_at": 0.0}

capture_candidates: list[dict[str, Any]] = []
manual_subtitle_candidates: list[dict[str, Any]] = []
manual_subtitle_pin: dict[str, str] = {"stream_key": "", "filename": ""}
srt_store: dict[str, str] = {"content": "", "filename": "subtitle.srt"}
STATE_LOCK: threading.RLock = threading.RLock()

LOG_BUFFER: list[dict[str, Any]] = []
MAX_LOG_ENTRIES: int = 200
LOG_LOCK: threading.Lock = threading.Lock()
LOG_TOTAL_COUNT: int = 0


# =============================================================================
# Host Rate Limiting & Transient Backoff
# =============================================================================

HOST_RATE_LIMIT_LOCK: threading.Lock = threading.Lock()
host_rate_limits: dict[str, float] = {}


def wait_if_host_paused(url: str, jitter: bool = True) -> None:
    """Pause execution if the target domain is temporarily rate-limited by upstream."""
    if not url:
        return
    domain = urlparse(url).netloc
    did_wait = False
    while True:
        now = time.time()
        with HOST_RATE_LIMIT_LOCK:
            wait_time = host_rate_limits.get(domain, 0.0) - now
        if wait_time > 0:
            did_wait = True
            time.sleep(min(wait_time, 1.0))
        else:
            if did_wait and jitter:
                time.sleep(random.uniform(0.1, 2.0))
            break


def set_host_pause(url: str, retry_after: float) -> None:
    """Record an upstream HTTP 429 Retry-After duration for the target domain."""
    if not url:
        return
    domain = urlparse(url).netloc
    with HOST_RATE_LIMIT_LOCK:
        current = host_rate_limits.get(domain, 0.0)
        host_rate_limits[domain] = max(current, time.time() + retry_after)


def is_host_paused(url: str) -> bool:
    """Return True if requests to the given domain are currently paused."""
    if not url:
        return False
    domain = urlparse(url).netloc
    with HOST_RATE_LIMIT_LOCK:
        return time.time() < host_rate_limits.get(domain, 0.0)

