# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     __VERSION__
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
"""
Stream Capture Engine, Title Evidence Resolution, and Page Metadata Tracker.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import re
import sys
import threading
import time
from typing import Any, NamedTuple
import urllib.parse

from core.state import (
    CAPTURE_TAB_META_TTL_SEC,
    HOST,
    MAX_CAPTURE_CANDIDATES,
    MAX_CAPTURE_TAB_META,
    PORT,
    STATE_LOCK,
    capture_active_state,
    capture_candidates,
    capture_tab_meta,
    current_stream,
    get_initial_stream_state,
    manual_subtitle_candidates,
    manual_subtitle_pin,
)
from subtitle_providers.jimaku import _is_subtitle_like_url, _stream_key
from utils.title_parser import clean_media_title, score_title

# =============================================================================
# Constants & Heuristic Thresholds
# =============================================================================

MIN_TITLE_LENGTH: int = 5
MIN_TITLE_CONFIDENCE: int = 10
MAX_CANDIDATE_LENGTH: int = 60
SPA_STREAM_GRACE_PERIOD: float = 3.0

# Source Priorities
PRIORITY_USER_OVERRIDE: int = 999
PRIORITY_PAGE_META_PARENT: int = 100
PRIORITY_HOOK: int = 80
PRIORITY_WEBREQUEST: int = 80
PRIORITY_PAGE_META_SAME_HOST: int = 60
PRIORITY_PAGE_META_IFRAME: int = 0

# Merge Decision Reasons
REASON_HIGHER_PRIO: str = "higher_priority"
REASON_LOWER_PRIO: str = "lower_priority"
REASON_BETTER_QUALITY: str = "better_quality"
REASON_LOWER_QUALITY: str = "lower_quality"
REASON_NEWER_TIMESTAMP: str = "newer_timestamp"
REASON_OLDER_TIMESTAMP: str = "older_timestamp"
REASON_SAME_TITLE: str = "same_title"


class MergeDecision(NamedTuple):
    """Result of comparing incoming title metadata against current stream title."""

    replace: bool
    reason: str
    new_priority: int
    old_priority: int


# =============================================================================
# Priority & Merge Decision Helpers
# =============================================================================

def get_source_priority(capture_source: str, is_top_frame: bool, is_host_match: bool) -> int:
    """Calculate integer authority priority based on capture source and frame relationship."""
    if capture_source == "page_meta":
        if is_top_frame:
            return PRIORITY_PAGE_META_PARENT
        if is_host_match:
            return PRIORITY_PAGE_META_SAME_HOST
        return PRIORITY_PAGE_META_IFRAME
    elif capture_source == "hook":
        return PRIORITY_HOOK
    elif capture_source == "webRequest":
        return PRIORITY_WEBREQUEST
    elif capture_source == "promote_candidate":
        return PRIORITY_USER_OVERRIDE
    return 0


def evaluate_title_merge(
    current_title: str,
    current_source: str,
    current_updated_at: float,
    incoming_title: str,
    incoming_source_type: str,
    incoming_updated_at: float,
    is_top_frame: bool,
    is_host_match: bool,
) -> MergeDecision:
    """
    Evaluate whether incoming_title should replace current_title.

    Rules hierarchy:
    1. Authority / Source Priority.
    2. Strong Recency (>15s jump indicates navigation event).
    3. Quality heuristic scoring.
    4. Exact title match tie-break.
    5. Weak Recency.
    """
    # 1. Authority / Priority
    new_priority = get_source_priority(incoming_source_type, is_top_frame, is_host_match)

    old_priority = 0
    if current_source == "promote_candidate":
        old_priority = PRIORITY_USER_OVERRIDE
    elif current_source == "page_meta_parent":
        old_priority = PRIORITY_PAGE_META_PARENT
    elif current_source == "hook":
        old_priority = PRIORITY_HOOK
    elif current_source == "webRequest":
        old_priority = PRIORITY_WEBREQUEST
    elif current_source == "page_meta_same_host":
        old_priority = PRIORITY_PAGE_META_SAME_HOST
    elif current_source == "page_meta_iframe":
        old_priority = PRIORITY_PAGE_META_IFRAME
    elif current_source:
        old_priority = get_source_priority(current_source, False, False)

    if new_priority > old_priority:
        return MergeDecision(True, REASON_HIGHER_PRIO, new_priority, old_priority)
    elif new_priority < old_priority:
        return MergeDecision(False, REASON_LOWER_PRIO, new_priority, old_priority)

    # 2. Strong Recency
    if (incoming_updated_at - current_updated_at) > 15.0:
        return MergeDecision(True, REASON_NEWER_TIMESTAMP, new_priority, old_priority)

    # 3. Quality
    incoming_score = score_title(clean_media_title(incoming_title))
    current_score = score_title(clean_media_title(current_title))

    if incoming_score > current_score:
        return MergeDecision(True, REASON_BETTER_QUALITY, new_priority, old_priority)
    elif incoming_score < current_score:
        return MergeDecision(False, REASON_LOWER_QUALITY, new_priority, old_priority)

    if incoming_title == current_title:
        return MergeDecision(True, REASON_SAME_TITLE, new_priority, old_priority)

    # 4. Weak Recency (tie-breaker for same page load)
    if incoming_updated_at >= current_updated_at:
        return MergeDecision(True, REASON_NEWER_TIMESTAMP, new_priority, old_priority)

    return MergeDecision(False, REASON_OLDER_TIMESTAMP, new_priority, old_priority)


# =============================================================================
# Capture Engine Mixin
# =============================================================================

class CaptureEngineMixin:
    """Mixin class providing stream capture state, title resolution, and event processing."""

    def _reset_stream_context(self, stream_obj: dict[str, Any]) -> None:
        """
        Clear transient stream state to prevent leaks when context changes.

        Uses get_initial_stream_state() so default definitions stay centralized in state.py.
        """
        initial = get_initial_stream_state()
        keys_to_preserve = {"stream_url", "stream_type", "m3u8_url", "subtitle_url", "subtitle_filename"}

        for k, v in initial.items():
            if k not in keys_to_preserve:
                stream_obj[k] = v

    def _clean_display_title(self, raw: str) -> str:
        """Strip junk suffixes/site titles to generate clean display title."""
        return clean_media_title(raw)

    def _normalize_url(self, raw_url: str, base_url: str = "") -> str:
        """Clean and normalize URL relative to optional base URL."""
        cleaned = self._clean_url(raw_url)
        if not cleaned:
            return ""
        if cleaned.startswith(("blob:", "data:", "javascript:", "mediastream:")):
            return ""
        try:
            if base_url:
                return urllib.parse.urljoin(base_url, cleaned)
            return urllib.parse.urlparse(cleaned).geturl()
        except Exception:
            return ""

    def _merge_title(
        self,
        target_obj: dict[str, Any],
        incoming_title: str,
        incoming_source_type: str,
        is_top_frame: bool,
        is_host_match: bool,
        incoming_updated_at: float | None = None,
        user_override: bool = False,
    ) -> bool:
        """
        Merge incoming_title into target_obj based on source priority logic.

        Returns True if the title was replaced.
        """
        incoming_t = str(incoming_title or "").strip()
        if not incoming_t:
            return False

        current_t = str(target_obj.get("title") or "").strip()
        current_source = target_obj.get("title_source", "")
        current_updated = float(target_obj.get("title_updated_at") or 0.0)

        if incoming_updated_at is None:
            incoming_updated_at = time.time()

        if user_override:
            decision = MergeDecision(True, "user_override", 999, 0)
        else:
            decision = evaluate_title_merge(
                current_t,
                current_source,
                current_updated,
                incoming_t,
                incoming_source_type,
                incoming_updated_at,
                is_top_frame,
                is_host_match,
            )

        if decision.replace:
            effective_source = incoming_source_type
            if incoming_source_type == "page_meta":
                if is_top_frame:
                    effective_source = "page_meta_parent"
                elif is_host_match:
                    effective_source = "page_meta_same_host"
                else:
                    effective_source = "page_meta_iframe"

            if incoming_t == current_t:
                self._log("DEBUG", f"[STATE] title preserved | current={current_t!r} | reason=same_title_higher_prio | old_src={current_source} | new_src={effective_source}")
            elif decision.reason == "same_title":
                self._log("DEBUG", f"[STATE] title preserved | current={current_t!r} | reason=same_title | old_src={current_source} | new_src={effective_source}")
            else:
                self._log("INFO", f"[STATE] title changed | old={current_t!r} | new={incoming_t!r} | reason={decision.reason} | old_src={current_source} | new_src={effective_source}")

            target_obj["title"] = incoming_t
            target_obj["title_source"] = effective_source
            target_obj["title_updated_at"] = incoming_updated_at

            if target_obj is current_stream:
                target_obj["display_title"] = self._clean_display_title(incoming_t)
            return True
        else:
            self._log("DEBUG", f"[STATE] title preserved | current={current_t!r} | incoming={incoming_t!r} | reason={decision.reason} | current_src={current_source} | incoming_src={incoming_source_type}")
            return False

    def _resolve_and_update_stream_title(self, incoming_title: str, incoming_candidates: list[Any]) -> None:
        """
        V2 Evidence Resolution Engine Integration.

        Resolves the title based on incoming title evidence and existing candidates,
        then updates current_stream.
        """
        from utils.evidence_resolver import resolve

        parsed_incoming = []
        if incoming_title:
            parsed_incoming.append({"value": incoming_title, "source": "title_tag"})

        if incoming_candidates:
            for cand in incoming_candidates:
                if not cand:
                    continue
                if isinstance(cand, str):
                    parsed_incoming.append({"value": cand, "source": "unknown"})
                elif isinstance(cand, dict):
                    val = cand.get("value") or cand.get("title")
                    if val:
                        src = cand.get("source") or "unknown"
                        parsed_incoming.append({"value": str(val), "source": str(src)})

        existing_candidates = current_stream.get("title_candidates") or []
        parsed_existing = []
        for cand in existing_candidates:
            if not cand:
                continue
            if isinstance(cand, str):
                parsed_existing.append({"value": cand, "source": "unknown"})
            elif isinstance(cand, dict):
                val = cand.get("value") or cand.get("title")
                if val:
                    src = cand.get("source") or "unknown"
                    parsed_existing.append({"value": str(val), "source": str(src)})

        # Filter out stale existing candidates from unrelated tabs/streams
        if incoming_title or incoming_candidates:
            from utils.evidence_resolver import get_tokens, token_similarity

            incoming_tokens = set()
            if incoming_title:
                incoming_tokens.update(get_tokens(incoming_title))
            for cand in incoming_candidates or []:
                v = cand.get("value") if isinstance(cand, dict) else str(cand or "")
                if v:
                    incoming_tokens.update(get_tokens(v))

            if incoming_tokens:
                filtered_existing = []
                for cand in parsed_existing:
                    v = cand.get("value", "")
                    cand_tokens = get_tokens(v)
                    # Retain existing candidate only if related to incoming stream evidence
                    if not cand_tokens or token_similarity(incoming_tokens, cand_tokens) > 0.15:
                        filtered_existing.append(cand)
                parsed_existing = filtered_existing

        seen = set()
        merged_candidates = []
        for cand in parsed_incoming + parsed_existing:
            val = cand["value"].strip()
            src = cand["source"].strip()
            if not val:
                continue
            key = (val.lower(), src.lower())
            if key not in seen:
                seen.add(key)
                merged_candidates.append({"value": val, "source": src})

        merged_candidates = merged_candidates[:30]
        old_title = current_stream.get("title") or ""
        resolved = resolve(merged_candidates, old_title)

        new_title = resolved.title

        if incoming_title or incoming_candidates:
            log_lines = [
                "",
                "[RESOLVER]",
                f"Current title: {old_title!r}",
                f"Incoming: {incoming_title!r}",
                "Evidence:",
                *[f" - {c['value']!r} ({c['source']})" for c in merged_candidates],
                "Clusters:",
            ]

            for c in getattr(resolved, "all_clusters", []):
                log_lines.append(f" - {c.normalized_title!r} = {c.total_score:.1f}")

            log_lines.append(f"Winner: {new_title!r}")
            if old_title != new_title:
                if not old_title:
                    log_lines.append("Reason: Initial title set")
                else:
                    log_lines.append("Reason: Higher heuristic score")
            else:
                log_lines.append("Reason: Current title preserved")

            self._log("INFO", "\n".join(log_lines))

        current_src = str(current_stream.get("title_source") or "")
        if current_src in ("promote_candidate", "user_override", "manual_restore"):
            self._log("INFO", f"[RESOLVER] preserving user override | title={old_title!r} | source={current_src}")
            current_stream["title_candidates"] = merged_candidates
            return

        current_stream["title"] = new_title
        current_stream["display_title"] = clean_media_title(new_title)
        current_stream["title_candidates"] = merged_candidates
        current_stream["title_source"] = resolved.winning_cluster.unique_sources[0] if resolved.winning_cluster.unique_sources else "unknown"
        current_stream["title_updated_at"] = time.time()

        # Async request for artwork
        from services.tmdb_service import TMDBService

        TMDBService.get_instance(lambda lvl, msg: self._log(lvl, msg)).request_artwork(current_stream)

    def _is_media_capture_target(self, url: str) -> bool:
        """Check if URL pattern matches known media streaming or manifest files."""
        lowered = (url or "").lower()
        if not lowered:
            return False
        if re.search(r"\.(m3u8|m3u|ts|m4s|mp4|webm|mkv|mov|key|mpd)(\?|$)", lowered):
            return True
        if re.search(r"(videoplayback|master\.m3u8|index-.*\.m3u8|/hls\d*/|/dash/|/stream/|/segment/|/dl/|/playlist/|/manifest/|/rendition/)", lowered):
            return True
        return False

    def _is_probably_audio_direct(self, url: str) -> bool:
        """Check if direct URL points exclusively to an audio-only stream."""
        lowered = (url or "").lower()
        if not lowered:
            return False
        has_audio = re.search(r"(^|[/_-])audio([/_-]|\d|$)|/audio/", lowered) is not None
        has_video = self._is_probably_video_direct(lowered)
        return has_audio and not has_video

    def _is_probably_init_segment(self, url: str) -> bool:
        """Check if URL points to an initialization or sample video chunk."""
        lowered = (url or "").lower()
        if not lowered:
            return False
        if re.search(r"[/_-]?(init|segment|frag|part|chunk)\d*\.(mp4|m4s|m4a|m4v|webm)(\?|$)", lowered):
            return True
        if lowered.endswith("init.mp4") or "init.mp4?" in lowered:
            return True
        if "initialization" in lowered or "init-stream" in lowered:
            return True
        if re.search(r"/(video|audio)_init", lowered):
            return True
        if "auto-play-sample" in lowered or "empty.mp4" in lowered or "dummy.mp4" in lowered:
            return True
        return False

    def _guess_master_playlist_fallback(self, variant_url: str, request_headers: dict[str, Any]) -> None:
        """Probe potential master playlist locations in the background when variant is captured."""
        def worker() -> None:
            if not variant_url or not variant_url.startswith("http"):
                return

            try:
                parsed = urllib.parse.urlparse(variant_url)
                base_dir = parsed.path.rsplit("/", 1)[0] if "/" in parsed.path else ""
                candidates = ["master.m3u8", "index.m3u8", "playlist.m3u8"]

                import requests

                for cand in candidates:
                    probe_url = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, f"{base_dir}/{cand}", "", "", ""))
                    try:
                        resp = requests.get(probe_url, headers=request_headers, timeout=5, stream=True)
                        if resp.status_code == 200:
                            content = resp.raw.read(2048).decode("utf-8", errors="ignore")
                            if "#EXT-X-STREAM-INF" in content:
                                with STATE_LOCK:
                                    if current_stream.get("stream_url") == variant_url or current_stream.get("m3u8_url") == variant_url:
                                        current_stream["hls_master_url"] = probe_url
                                        current_stream["stream_url"] = probe_url
                                        self._log("INFO", f"Master Playlist Guesser found and upgraded to: {probe_url}")
                                return
                    except Exception:
                        pass
            except Exception as e:
                self._log("DEBUG", f"Master Playlist Guesser error: {e}")

        threading.Thread(target=worker, daemon=True).start()


    # =========================================================================
    # Set Stream Handler & Normalizers
    # =========================================================================

    def _handle_set_stream(self) -> None:
        """
        Handle POST `/set-stream` Endpoint.

        Receives and processes the active stream payload sent by the Chrome extension.
        Workflow:
        1. Extracts referer, cookie, UA, origin, and media stream URL.
        2. Normalizes relative URLs into absolute URLs.
        3. Upgrades title using complete title candidates if primary title is too short.
        4. Clears manual subtitle pin state if the stream changes.
        5. Saves cookies, referer, and request headers to the global `current_stream` state.
        """
        try:
            data = self._read_json_body()
        except Exception as exc:
            self._send_json(400, {"status": "error", "message": str(exc)})
            return

        capture_source = data.get("capture_source", "unknown")
        capture_id = data.get("capture_id", "unknown")
        capture_stage = data.get("capture_stage", "unknown")
        capture_ts = data.get("capture_timestamp", 0)
        cooldown_key = data.get("cooldown_key", "unknown")

        referer = self._clean_url(data.get("referer") or "")
        cookie = (data.get("cookie") or "").strip()
        input_stream_url = data.get("stream_url") or data.get("m3u8_url") or ""
        resolved_stream_url = self._normalize_url(input_stream_url, referer)
        resolved_subtitle_url = self._normalize_url(data.get("subtitle_url") or "", referer)
        stream_type = self._infer_stream_type(resolved_stream_url, data.get("stream_type") or "")
        user_agent = (data.get("user_agent") or self.headers.get("User-Agent") or "").strip()
        origin = (data.get("origin") or "").strip()
        request_headers = self._sanitize_forward_headers(data.get("request_headers") or {})
        incoming_map = self._sanitize_url_header_map(data.get("url_header_map") or {})
        hls_master_url = self._normalize_url(data.get("hls_master_url") or "", referer)
        title = (data.get("title") or "").strip() or "Untitled Stream"
        raw_title_candidates = data.get("title_candidates") or []
        episode = data.get("episode")
        season = data.get("season")
        detected_episode = data.get("detected_episode")
        page_url = self._clean_url(data.get("page_url") or "")
        tab_id = data.get("tab_id", -1)
        try:
            tab_id = int(tab_id)
        except Exception:
            tab_id = -1
        if isinstance(episode, str) and episode.isdigit():
            episode = int(episode)
        if isinstance(season, str) and season.isdigit():
            season = int(season)
        if not isinstance(episode, int):
            episode = None
        if not isinstance(season, int):
            season = None
        if isinstance(detected_episode, str) and detected_episode.isdigit():
            detected_episode = int(detected_episode)
        if not isinstance(detected_episode, int):
            detected_episode = None

        if not self._is_valid_http_url(resolved_stream_url):
            self._log("DEBUG", f"[{capture_source}] DROP reason=invalid_url | capture={capture_id} | url={resolved_stream_url[:60]}")
            self._send_json(400, {"status": "error", "message": "stream_url is invalid"})
            return

        if _is_bridge_local_url(resolved_stream_url):
            self._log("DEBUG", f"[{capture_source}] DROP reason=bridge_local | capture={capture_id} | url={resolved_stream_url[:60]}")
            self._send_json(
                202,
                {
                    "status": "ignored",
                    "message": "bridge local URL skipped to keep stream capture stable",
                    "stream_url": resolved_stream_url,
                },
            )
            return

        if _is_subtitle_like_url(resolved_stream_url):
            self._log("DEBUG", f"[{capture_source}] DROP reason=subtitle_url | capture={capture_id} | url={resolved_stream_url[:60]}")
            self._send_json(
                202,
                {
                    "status": "ignored",
                    "message": "subtitle/caption URL skipped to keep video stream stable",
                    "stream_url": resolved_stream_url,
                },
            )
            return

        if stream_type == "direct" and self._is_probably_audio_direct(resolved_stream_url):
            self._log("DEBUG", f"[{capture_source}] DROP reason=audio_direct | capture={capture_id} | url={resolved_stream_url[:60]}")
            self._send_json(
                202,
                {
                    "status": "ignored",
                    "message": "direct audio-only skipped to keep video stream stable",
                    "stream_url": resolved_stream_url,
                },
            )
            return

        if stream_type == "direct" and self._is_probably_init_segment(resolved_stream_url):
            self._log("DEBUG", f"[{capture_source}] DROP reason=init_segment | capture={capture_id} | url={resolved_stream_url[:60]}")
            self._send_json(
                202,
                {
                    "status": "ignored",
                    "message": "init segment skipped to prevent overwriting active stream",
                    "stream_url": resolved_stream_url,
                },
            )
            return

        # Update active stream state on server in a thread-safe manner
        with STATE_LOCK:
            ownership = current_stream.get("ownership")
            is_extension_source = capture_source in ("hook", "webRequest", "page_meta_iframe")
            if ownership and ownership.get("mode") == "manual_restore":
                if time.time() - ownership.get("created_at", 0) > 43200:
                    self._log("WARN", f"[{capture_source}] ownership fuse tripped after 12 hours | clearing ownership")
                    current_stream.pop("ownership", None)
                    ownership = None
                elif not is_extension_source:
                    self._log("INFO", f"[{capture_source}] ownership cleared by non-extension source")
                    current_stream.pop("ownership", None)
                    ownership = None
                else:
                    old_page = ownership.get("page_url") or ""
                    new_page_norm = self._normalize_url(page_url) if page_url else ""

                    if new_page_norm and new_page_norm != old_page:
                        self._log("INFO", f"[{capture_source}] ownership cleared | reason=new_valid_stream | old_page={old_page[:60]} | new_page={new_page_norm[:60]}")
                        current_stream.pop("ownership", None)
                        ownership = None
                    elif self._normalize_url(resolved_stream_url) != ownership.get("stream_url", ""):
                        self._log("INFO", f"[{capture_source}] DROP reason=ownership_protected | incoming={resolved_stream_url[:60]} | protected={ownership.get('stream_url', '')[:60]}")
                        self._send_json(202, {
                            "status": "ignored",
                            "message": "stream is protected by ownership",
                        })
                        return

            existing_master_url = self._normalize_url(current_stream.get("hls_master_url") or current_stream.get("stream_url") or "")
            keep_existing_master = (
                stream_type == "hls"
                and self._is_hls_variant_url(resolved_stream_url)
                and self._is_hls_master_url(existing_master_url)
                and self._same_hls_session(existing_master_url, resolved_stream_url)
            )

            active_tab_id = capture_active_state.get("tab_id", -1)

            is_new_tab = (tab_id != -1 and active_tab_id != -1 and tab_id != active_tab_id)
            is_new_stream = (
                not keep_existing_master
                and not self._same_hls_session(resolved_stream_url, current_stream.get("stream_url") or "")
            )

            # Capture true old_title BEFORE stream context reset alters current_stream["title"]
            old_title = current_stream.get("title") or ""

            if is_new_tab or is_new_stream:
                reason = "tab_changed" if is_new_tab else "stream_changed"
                self._log("INFO", f"[STATE] stream context reset | reason={reason} | clearing transient state")
                self._reset_stream_context(current_stream)

            # Resolve and update title
            self._resolve_and_update_stream_title(title, raw_title_candidates)
            resolved_title = current_stream.get("title")

            self._log(
                "DEBUG",
                f"[DIAG] title pipeline | "
                f"incoming_raw={title!r} | "
                f"candidates={repr(raw_title_candidates)} | "
                f"resolved={resolved_title!r} | "
                f"cleaned={current_stream.get('display_title')!r} | "
                f"source={capture_source}",
            )

            if not keep_existing_master:
                _clear_manual_pin_if_stream_changed_unlocked(resolved_title, resolved_stream_url)
                current_stream["stream_url"] = resolved_stream_url
                current_stream["stream_type"] = stream_type
                current_stream["m3u8_url"] = resolved_stream_url
            else:
                self._log("DEBUG", f"[{capture_source}] DROP reason=hls_master_kept | capture={capture_id} | url={resolved_stream_url[:60]}")

            if resolved_title != old_title:
                current_stream["subtitle_url"] = ""
                current_stream["subtitle_filename"] = ""
                if episode is not None:
                    old_ep = current_stream.get("episode")
                    if old_ep != episode:
                        self._log("INFO", f"[STATE] episode changed | {old_ep} -> {episode} | reason=new_stream_context | source={capture_source} | capture={capture_id} | stream={resolved_stream_url[:60]} | title={resolved_title}")
                    else:
                        self._log("DEBUG", f"[STATE] episode preserved | current={old_ep} | incoming={episode} | reason=new_stream_context_skip | source={capture_source} | capture={capture_id} | stream={resolved_stream_url[:60]} | title={resolved_title}")
                    current_stream["episode"] = episode
                else:
                    current_stream.pop("episode", None)

                if season is not None:
                    current_stream["season"] = season
                else:
                    current_stream.pop("season", None)

                if detected_episode is not None:
                    current_stream["detected_episode"] = detected_episode
                else:
                    current_stream.pop("detected_episode", None)
            else:
                if episode is not None:
                    old_ep = current_stream.get("episode")
                    if old_ep != episode:
                        current_stream["subtitle_url"] = ""
                        current_stream["subtitle_filename"] = ""
                        self._log("INFO", f"[STATE] episode changed | {old_ep} -> {episode} | reason=stream_update | source={capture_source} | capture={capture_id} | stream={resolved_stream_url[:60]} | title={resolved_title}")
                    else:
                        self._log("DEBUG", f"[STATE] episode preserved | current={old_ep} | incoming={episode} | reason=stream_update_skip | source={capture_source} | capture={capture_id} | stream={resolved_stream_url[:60]} | title={resolved_title}")
                    current_stream["episode"] = episode
                else:
                    self._log("INFO", f"[STATE] episode preserved | current={current_stream.get('episode')} | incoming={episode} | reason=stream_update_skip | source={capture_source} | capture={capture_id} | title={resolved_title}")
                if season is not None:
                    current_stream["season"] = season
                if detected_episode is not None:
                    current_stream["detected_episode"] = detected_episode
            if page_url:
                current_stream["page_url"] = page_url

            # Store referer/cookie/UA if provided by extension
            if referer:
                current_stream["referer"] = referer
            if cookie:
                current_stream["cookie"] = cookie
            if user_agent:
                current_stream["user_agent"] = user_agent
            if origin:
                current_stream["origin"] = origin
            if request_headers:
                current_stream["request_headers"] = request_headers
            if hls_master_url and (not keep_existing_master or self._is_hls_master_url(hls_master_url)):
                current_stream["hls_master_url"] = hls_master_url

            # Merge URL header map (recording cookies for HLS CDN requests)
            existing_map = current_stream.get("url_header_map") or {}
            if not isinstance(existing_map, dict):
                existing_map = {}
            merged_map = dict(existing_map)
            merged_map.update(incoming_map)
            merged_map = self._trim_header_map(merged_map)
            current_stream["url_header_map"] = merged_map

            # Ensure the stream URL itself has a header snapshot when available.
            if request_headers:
                normalized_stream_key = self._normalize_header_map_key(resolved_stream_url)
                merged_map[resolved_stream_url] = request_headers
                if normalized_stream_key:
                    merged_map[normalized_stream_key] = request_headers

            # Only overwrite subtitle if incoming actually provides one.
            if resolved_subtitle_url:
                current_stream["subtitle_url"] = resolved_subtitle_url

            if not keep_existing_master:
                current_stream["content_type"] = self._guess_content_type(resolved_stream_url)
            current_stream["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()

            if not keep_existing_master:
                self._log("INFO", f"[SET_STREAM] tab_id set to {tab_id} | source={capture_source!r} | stream={resolved_stream_url[:60]!r}")
                capture_active_state.update({
                    "score": self._capture_score(resolved_stream_url, {"response_content_type": self._guess_content_type(resolved_stream_url)}),
                    "url_key": self._normalize_header_map_key(resolved_stream_url) or resolved_stream_url,
                    "tab_id": tab_id,
                    "updated_at": time.time(),
                })

        if stream_type == "hls":
            with STATE_LOCK:
                needs_guesser = not self._is_hls_master_url(current_stream.get("hls_master_url") or "")
            if needs_guesser:
                self._guess_master_playlist_fallback(resolved_stream_url, request_headers)

        elapsed_backend = int((time.time() * 1000) - capture_ts) if capture_ts else 0
        self._log(
            "INFO",
            f"[{capture_source}] stream saved | "
            f"capture={capture_id} | "
            f"type={stream_type} | "
            f"url={resolved_stream_url[:160]} | "
            f"key={cooldown_key} | "
            f"header_map={len(merged_map)} | "
            f"has_index={any('index' in k and '.m3u8' in k for k in merged_map.keys())} | "
            f"active={'master-kept' if keep_existing_master else 'promoted'} | "
            f"subtitle={bool(resolved_subtitle_url)} | "
            f"elapsed_ms={elapsed_backend} | "
            f"title={resolved_title}",
        )
        stream_snapshot = self._snapshot_stream(include_replay_map=False)
        set_stream_score = self._capture_score(
            resolved_stream_url,
            {"response_content_type": stream_snapshot.get("content_type") or ""},
        )
        candidate_score = max(1, set_stream_score)
        set_stream_candidate = {
            "id": hashlib.sha1(
                (self._normalize_header_map_key(resolved_stream_url) or resolved_stream_url).encode(
                    "utf-8",
                    errors="ignore",
                )
            ).hexdigest()[:16],
            "url": resolved_stream_url,
            "url_key": self._normalize_header_map_key(resolved_stream_url),
            "stream_type": stream_type,
            "title": resolved_title,
            "display_title": current_stream["display_title"],
            "title_candidates": current_stream["title_candidates"],
            "page_url": referer,
            "source_host": self._capture_host(referer),
            "stream_host": self._capture_host(resolved_stream_url),
            "score": candidate_score,
            "confidence": 100,
            "headers": dict(request_headers or {}),
            "episode": episode,
            "season": season,
            "tab_id": -1,
            "updated_at": stream_snapshot.get("updated_at"),
        }
        self._store_capture_candidate(set_stream_candidate)

        self._send_json(
            200,
            {
                "status": "ok",
                "stream": {
                    "stream_url": stream_snapshot.get("stream_url"),
                    "stream_type": stream_snapshot.get("stream_type"),
                    "m3u8_url": stream_snapshot.get("m3u8_url"),
                    "referer": stream_snapshot.get("referer"),
                    "subtitle_url": stream_snapshot.get("subtitle_url"),
                    "title": stream_snapshot.get("title"),
                    "display_title": stream_snapshot.get("display_title"),
                    "title_candidates": stream_snapshot.get("title_candidates"),
                    "updated_at": stream_snapshot.get("updated_at"),
                },
            },
        )

    def _normalize_positive_int(self, value: Any) -> int | None:
        """Parse value into a positive integer, returning None on negative/zero/invalid."""
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value if value > 0 else None
        if isinstance(value, str):
            text = value.strip()
            if text.isdigit():
                parsed = int(text)
                return parsed if parsed > 0 else None
        return None

    def _capture_tab_id(self, data: dict[str, Any]) -> int:
        """Extract integer tab ID from incoming request data."""
        value = data.get("tab_id", data.get("tabId", -1))
        try:
            return int(value)
        except Exception:
            return -1

    def _trim_capture_tab_meta_unlocked(self, now: float | None = None) -> None:
        """Drop stale per-tab metadata so long browser sessions stay bounded."""
        current_time = float(now if now is not None else time.time())
        stale_ids = [
            tab_id
            for tab_id, meta in capture_tab_meta.items()
            if current_time - float(meta.get("updated_at") or 0) > CAPTURE_TAB_META_TTL_SEC
        ]
        for tab_id in stale_ids:
            capture_tab_meta.pop(tab_id, None)

        while len(capture_tab_meta) > MAX_CAPTURE_TAB_META:
            oldest_tab_id = min(
                capture_tab_meta,
                key=lambda key: float((capture_tab_meta.get(key) or {}).get("updated_at") or 0),
            )
            capture_tab_meta.pop(oldest_tab_id, None)

    def _store_capture_page_meta(self, data: dict[str, Any]) -> None:
        """Store scraped page metadata from extension content script and update title if matched."""
        tab_id = self._capture_tab_id(data)
        if tab_id < 0:
            return

        title_candidates: list[dict[str, str]] = []
        raw_candidates = data.get("title_candidates") or []
        if isinstance(raw_candidates, list):
            seen: set[tuple[str, str]] = set()
            for value in raw_candidates:
                if isinstance(value, str):
                    candidate = re.sub(r"\s+", " ", value).strip()
                    if candidate and len(candidate) <= 180:
                        key = (candidate.lower(), "unknown")
                        if key not in seen:
                            seen.add(key)
                            title_candidates.append({"value": candidate, "source": "unknown"})
                elif isinstance(value, dict):
                    val = value.get("value") or value.get("title")
                    if val:
                        candidate = re.sub(r"\s+", " ", str(val)).strip()
                        src = str(value.get("source") or "unknown").strip()
                        if candidate and len(candidate) <= 180:
                            key = (candidate.lower(), src.lower())
                            if key not in seen:
                                seen.add(key)
                                title_candidates.append({"value": candidate, "source": src})
                if len(title_candidates) >= 30:
                    break

        meta = {
            "title": re.sub(r"\s+", " ", str(data.get("title") or "")).strip(),
            "title_candidates": title_candidates,
            "episode": self._normalize_positive_int(data.get("episode")),
            "season": self._normalize_positive_int(data.get("season")),
            "has_video": bool(data.get("has_video")),
            "video_count": self._normalize_positive_int(data.get("video_count")) or 0,
            "page_url": self._normalize_url(data.get("page_url") or ""),
            "is_top_frame": bool(data.get("is_top_frame")),
            "frame_url": self._normalize_url(data.get("frame_url") or ""),
            "perf_now": data.get("perf_now"),
            "updated_at": time.time(),
            "page_kind": data.get("page_kind") or "entity",
            "page_reason": data.get("page_reason") or "default",
        }
        with STATE_LOCK:
            ownership = current_stream.get("ownership")
            if ownership and ownership.get("mode") == "manual_restore":
                if time.time() - ownership.get("created_at", 0) > 43200:
                    current_stream.pop("ownership", None)
                else:
                    self._log("DEBUG", f"[PAGE_META] DROP reason=ownership_protected | url={meta.get('frame_url')!r}")
                    return

            capture_tab_meta[tab_id] = meta
            self._trim_capture_tab_meta_unlocked(meta["updated_at"])
            active_tab_id = capture_active_state.get("tab_id", -1)
            active_ref = current_stream.get("referer") or ""
            active_page = current_stream.get("page_url") or ""
            incoming_page = meta.get("page_url") or ""

            is_url_match = False
            if incoming_page and (incoming_page == active_ref or incoming_page == active_page):
                is_url_match = True

            is_tab_match = active_tab_id == tab_id
            if is_tab_match and incoming_page and active_page and incoming_page != active_page:
                parsed_in = urllib.parse.urlparse(incoming_page)
                parsed_act = urllib.parse.urlparse(active_page)
                if parsed_in.netloc == parsed_act.netloc:
                    # Allow SPA navigations (same host) to update the title even if path/hash changed
                    try:
                        last_ts = datetime.datetime.fromisoformat(current_stream.get("updated_at")).timestamp()
                    except Exception:
                        last_ts = 0.0
                    time_since_update = time.time() - last_ts

                    if time_since_update < SPA_STREAM_GRACE_PERIOD:
                        self._log("INFO", f"[PAGE_META] SPA navigation detected | old={active_page} | new={incoming_page} | keeping recent stream (grace period)")
                        # DO NOT wipe stream URLs, just clear titles
                        current_stream["title_candidates"] = []
                        current_stream["title"] = ""
                        current_stream["page_url"] = incoming_page
                        meta["title_candidates"] = []
                    else:
                        self._log("INFO", f"[PAGE_META] SPA navigation detected | old={active_page} | new={incoming_page} | clearing old candidates and stream")
                        self._reset_stream_context(current_stream)
                        current_stream["stream_url"] = ""
                        current_stream["m3u8_url"] = ""
                        current_stream["hls_master_url"] = ""
                        current_stream["title_candidates"] = []
                        current_stream["title"] = ""
                        current_stream["page_url"] = incoming_page
                        meta["title_candidates"] = []
                else:
                    is_tab_match = False

            if is_url_match:
                is_tab_match = True
                capture_active_state["tab_id"] = tab_id

            is_host_match = False
            if not is_tab_match and active_tab_id < 0 and incoming_page:
                incoming_host = self._capture_host(incoming_page)
                if incoming_host and (
                    incoming_host == self._capture_host(active_ref)
                    or incoming_host == self._capture_host(active_page)
                ):
                    is_host_match = True
                    capture_active_state["tab_id"] = tab_id

            if (is_tab_match or is_host_match) and current_stream.get("stream_url"):
                self._log(
                    "INFO",
                    f"[PAGE_META] received | tab_match={is_tab_match} | host_match={is_host_match}"
                    f" | top={meta.get('is_top_frame')} | url={meta.get('frame_url')!r}"
                    f" | perf={meta.get('perf_now')}"
                    f" | episode={meta['episode']!r} | title={meta['title']!r}"
                    f" | kind={meta.get('page_kind')}",
                )
                if meta.get("is_top_frame"):
                    page_kind = meta.get("page_kind")
                    if page_kind == "listing":
                        self._log(
                            "INFO",
                            f"[PAGE_META] skip title merge | reason=listing_page"
                            f" | kind_reason={meta.get('page_reason')}",
                        )
                    else:
                        incoming_title = meta["title"] or ""
                        old_title = current_stream.get("title")
                        self._resolve_and_update_stream_title(incoming_title, meta["title_candidates"])
                        new_title = current_stream.get("title")

                        if new_title != old_title:
                            with STATE_LOCK:
                                header_map_keys = set((current_stream.get("url_header_map") or {}).keys())
                                for cand in capture_candidates:
                                    cand_url = cand.get("url") or ""
                                    cand_key = cand.get("url_key") or ""
                                    if (
                                        cand_url == current_stream.get("stream_url")
                                        or cand_url in header_map_keys
                                        or cand_key in header_map_keys
                                    ):
                                        cand["title"] = new_title
                                        cand["display_title"] = clean_media_title(new_title)
                                        cand["title_candidates"] = current_stream["title_candidates"]
                                        cand["episode"] = meta["episode"]
                                        cand["season"] = meta["season"]
                                        cand["page_url"] = meta.get("page_url") or cand.get("page_url")
            else:
                self._log(
                    "INFO",
                    f"[PAGE_META] rejected | tab_match={is_tab_match} | host_match={is_host_match}"
                    f" | top={meta.get('is_top_frame')} | url={meta.get('frame_url')!r}"
                    f" | perf={meta.get('perf_now')}"
                    f" | episode={meta['episode']!r} | title={meta['title']!r}"
                    f" | kind={meta.get('page_kind')}",
                )

    # =========================================================================
    # Candidate Scoring & Confidence Evaluation
    # =========================================================================

    def _capture_score(self, url: str, data: dict[str, Any]) -> int:
        """Calculate integer heuristics score for captured media stream URL."""
        lowered = (url or "").lower()
        content_type = str(data.get("response_content_type") or "").lower()
        if _is_bridge_local_url(url):
            return 0
        if _is_subtitle_like_url(url):
            return 0
        if not self._is_media_capture_target(url):
            return 0
        if ".key" in lowered or re.search(r"\.(ts|m4s)(\?|$)", lowered):
            return 0
        if self._is_probably_init_segment(url):
            return 0
        if self._is_probably_audio_direct(url):
            return 0
        if ".m3u8" in lowered or "mpegurl" in content_type:
            if self._is_hls_master_url(url):
                return 1000
            if self._is_hls_variant_url(url):
                return 820
            if re.search(r"(master|index|playlist|manifest)", lowered):
                return 950
            return 900
        if re.search(r"\.(mp4|webm|mkv|mov)(\?|$)", lowered) or "videoplayback" in lowered:
            return 700
        return 250

    def _capture_host(self, url: str) -> str:
        """Extract netloc/hostname from URL string."""
        try:
            return urllib.parse.urlparse(str(url or "")).netloc
        except Exception:
            return ""

    def _capture_confidence(self, url: str, data: dict[str, Any], score: int, meta: dict[str, Any]) -> int:
        """Calculate confidence score (0-100) based on page metadata and tab state."""
        if score <= 0:
            return 0
        lowered = str(url or "").lower()
        confidence = 0
        if score >= 900:
            confidence += 35
        elif score >= 700:
            confidence += 25
        else:
            confidence += 10
        if bool(data.get("is_active_tab")):
            confidence += 25
        if bool(meta.get("has_video")) or int(meta.get("video_count") or 0) > 0:
            confidence += 20
        if meta.get("episode") or meta.get("season"):
            confidence += 10
        title = str(meta.get("title") or "").strip().lower()
        if title and title not in {"untitled", "untitled stream"}:
            confidence += 10
        if ".m3u8" in lowered or "mpegurl" in str(data.get("response_content_type") or "").lower():
            confidence += 10
        if ".key" in lowered or re.search(r"\.(ts|m4s)(\?|$)", lowered):
            confidence -= 80
        if self._is_probably_audio_direct(url):
            confidence -= 80
        return max(0, min(100, confidence))

    def _build_capture_candidate(
        self,
        url: str,
        url_key: str,
        data: dict[str, Any],
        headers: dict[str, Any],
        score: int,
    ) -> dict[str, Any]:
        """Construct candidate dictionary for stream evaluation table."""
        tab_id = self._capture_tab_id(data)
        meta = self._capture_meta_for_tab(tab_id)
        stream_type = self._infer_stream_type(url)
        page_url = meta.get("page_url") or self._normalize_url(data.get("page_url") or data.get("document_url") or data.get("initiator") or "")
        title = data.get("title") or meta.get("title") or self._clean_url(page_url) or "Captured by Bridge Extension"
        source_host = self._capture_host(page_url)
        stream_host = self._capture_host(url)
        candidate_key = url_key or url
        candidate_id = hashlib.sha1(candidate_key.encode("utf-8", errors="ignore")).hexdigest()[:16]
        confidence = self._capture_confidence(url, data, score, meta)

        episode = self._normalize_positive_int(data.get("episode") or meta.get("episode"))
        season = self._normalize_positive_int(data.get("season") or meta.get("season"))
        title_candidates = data.get("title_candidates") or meta.get("title_candidates") or []

        return {
            "id": candidate_id,
            "url": url,
            "url_key": url_key,
            "stream_type": stream_type,
            "title": title,
            "display_title": self._clean_display_title(title),
            "title_candidates": title_candidates,
            "page_url": page_url,
            "source_host": source_host,
            "stream_host": stream_host,
            "score": score,
            "confidence": confidence,
            "headers": dict(headers or {}),
            "episode": episode,
            "season": season,
            "tab_id": tab_id,
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }

    # =========================================================================
    # Capture Event & Request Handlers
    # =========================================================================

    def _handle_capture_event(self) -> None:
        """Handle POST `/capture-event` endpoint from extension webRequest / parasite hooks."""
        try:
            data = self._read_json_body()
        except Exception as exc:
            self._send_json(400, {"status": "error", "message": str(exc)})
            return

        event_type = str(data.get("event_type") or "").strip().lower()
        if event_type == "page_meta":
            self._store_capture_page_meta(data)
            self._send_json(200, {"status": "ok", "stored": "page_meta"})
            return

        if event_type != "request":
            self._send_json(202, {"status": "ignored", "message": "event ignored"})
            return

        raw_url = data.get("url") or ""
        url = self._normalize_url(raw_url)
        if not self._is_valid_http_url(url):
            self._send_json(400, {"status": "error", "message": "url is invalid"})
            return
        if _is_bridge_local_url(url):
            self._send_json(202, {"status": "ignored", "message": "bridge local URL skipped"})
            return
        if not self._is_media_capture_target(url):
            self._send_json(202, {"status": "ignored", "message": "not a media target"})
            return

        url_key = self._normalize_header_map_key(data.get("url_key") or raw_url or url)
        headers = self._sanitize_forward_headers(data.get("request_headers") or {})
        score = self._capture_score(url, data)
        if score <= 0:
            self._send_json(202, {"status": "ignored", "message": "low-value media target"})
            return

        map_size = self._store_capture_headers(url, url_key, headers)
        promoted = False
        candidate = self._build_capture_candidate(url, url_key, data, headers, score)
        confidence = int(candidate.get("confidence") or 0)
        self._store_capture_candidate(candidate)
        promoted = self._promote_capture_candidate(candidate)

        if promoted:
            self._log(
                "INFO",
                "stream captured | "
                f"type={self._infer_stream_type(url)} | "
                f"score={score} | "
                f"confidence={confidence} | "
                f"url={url[:160]} | "
                f"header_map={map_size}",
            )
            status_code = 200
            status = "ok"
        else:
            status_code = 202
            status = "stored"

        self._send_json(
            status_code,
            {
                "status": status,
                "promoted": promoted,
                "score": score,
                "confidence": confidence,
                "map_size": map_size,
            },
        )

    def _handle_capture_request(self) -> None:
        """Handle POST `/capture-request` endpoint to record individual media stream headers."""
        try:
            data = self._read_json_body()
        except Exception as exc:
            self._send_json(400, {"status": "error", "message": str(exc)})
            return

        raw_url = data.get("url") or ""
        url = self._normalize_url(raw_url)
        if not self._is_valid_http_url(url):
            self._send_json(400, {"status": "error", "message": "url is invalid"})
            return
        if _is_bridge_local_url(url):
            self._send_json(202, {"status": "ignored", "message": "bridge local URL skipped"})
            return
        if not self._is_media_capture_target(url):
            self._send_json(202, {"status": "ignored", "message": "url is not a media target"})
            return

        raw_url_key = data.get("url_key") or ""
        url_key = self._normalize_header_map_key(raw_url_key or url)
        headers = self._sanitize_forward_headers(data.get("request_headers") or {})
        if not headers:
            self._send_json(202, {"status": "ignored", "message": "request_headers is empty"})
            return

        score = self._capture_score(url, data)
        if score <= 0:
            self._send_json(202, {"status": "ignored", "message": "low-value media target"})
            return

        candidate = self._build_capture_candidate(url, url_key, data, headers, score)
        self._store_capture_candidate(candidate)

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

            # Refresh identity headers only when extension provides stronger values.
            if headers.get("cookie"):
                current_stream["cookie"] = headers.get("cookie")
            if headers.get("referer"):
                current_stream["referer"] = headers.get("referer")
            if headers.get("origin"):
                current_stream["origin"] = headers.get("origin")
            if headers.get("user-agent"):
                current_stream["user_agent"] = headers.get("user-agent")

            # Keep a latest global request_headers snapshot as fallback.
            current_stream["request_headers"] = headers
            current_stream["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()

        self._log(
            "DEBUG",
            "capture request received | "
            f"url={url[:140]} | "
            f"key={url_key[:140]} | "
            f"headers={len(headers)} | "
            f"map_size={len(header_map)} | "
            f"has_cookie={'cookie' in headers}",
        )

        self._send_json(
            200,
            {
                "status": "ok",
                "stored_url": url,
                "stored_key": url_key,
                "map_size": len(header_map),
            },
        )

    # =========================================================================
    # Inspection & Diagnostics Endpoints
    # =========================================================================

    def _handle_current_stream(self) -> None:
        """Handle GET `/current-stream` endpoint for dashboard polling."""
        stream_payload = self._public_stream_snapshot()
        stream_payload["episode"] = stream_payload.get("episode")
        stream_payload["season"] = stream_payload.get("season")
        stream_payload["detected_episode"] = stream_payload.get("detected_episode")
        self._send_json(
            200,
            {
                "status": "ok",
                "has_stream": stream_payload.get("stream_url") is not None,
                "stream": stream_payload,
                "jimaku_active": getattr(sys, "modules", {}).get("server", lambda: None).__dict__.get("_jimaku_worker", None) is not None,
                "playback_url": (
                    f"http://{HOST}:{PORT}/stream.m3u8"
                    if stream_payload.get("stream_type") == "hls"
                    else f"http://{HOST}:{PORT}/stream-direct"
                ),
                "bridge_origin": f"http://{HOST}:{PORT}",
            },
        )

    def _handle_debug_episode(self) -> None:
        """Handle GET `/debug-episode` endpoint to inspect raw episode parser outputs."""
        stream_snapshot = self._snapshot_stream(include_replay_map=False)
        self._send_json(
            200,
            {
                "stream_url": stream_snapshot.get("stream_url"),
                "title": stream_snapshot.get("title"),
                "episode": stream_snapshot.get("episode"),
                "season": stream_snapshot.get("season"),
                "detected_episode": stream_snapshot.get("detected_episode"),
                "stream_type": stream_snapshot.get("stream_type"),
            },
        )

    def _handle_stream_duration(self, qs: dict[str, list[str]] | None) -> None:
        """Calculate stream duration server-side by parsing M3U8 EXTINF tags."""
        query_url = qs.get("url", [""])[0] if qs else ""
        if query_url:
            query_url = urllib.parse.unquote(query_url)

        if not query_url:
            self._send_json(400, {"error": "No stream URL available", "duration_sec": 0})
            return

        parsed_url = urllib.parse.urlparse(query_url)
        if parsed_url.scheme not in ("http", "https"):
            self._send_json(400, {"error": "Invalid scheme", "duration_sec": 0})
            return

        self._log("INFO", f"[stream-duration] requested_url={query_url}")
        stream_url = query_url

        try:
            hls_headers = self._build_hls_upstream_headers(stream_url)
            if not hls_headers:
                self._send_json(424, {"status": "error", "message": "No headers available", "duration_sec": 0})
                return

            req = self._make_request(stream_url, hls_headers)
            with self._urlopen(req, timeout=15) as resp:
                text = resp.read().decode("utf-8", errors="replace")

            # Fast check: If it's an MPD (XML), skip M3U8 parsing
            if "<MPD" in text or "<?xml" in text or "#EXTM3U" not in text:
                self._send_json(200, {"status": "ok", "duration_sec": 0})
                return

            # Try to parse EXTINF from this playlist
            duration = sum(float(m.group(1)) for m in re.finditer(r"#EXTINF:\s*([\d.]+)", text))

            if duration < 1:
                # It's a master playlist - try first variant
                for raw_line in text.splitlines():
                    line = raw_line.strip()
                    # Strip any control characters like \x00
                    line = re.sub(r"[\x00-\x1f\x7f]", "", line)
                    if line and not line.startswith("#"):
                        variant_url = urllib.parse.urljoin(stream_url, line)
                        try:
                            vreq = self._make_request(variant_url, hls_headers)
                            with self._urlopen(vreq, timeout=15) as vresp:
                                vtext = vresp.read().decode("utf-8", errors="replace")
                            duration = sum(float(m.group(1)) for m in re.finditer(r"#EXTINF:\s*([\d.]+)", vtext))
                            if duration > 0:
                                break
                        except Exception as ve:
                            self._log("WARN", f"Failed to fetch variant {variant_url}: {ve}")
                            continue

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()

            self.wfile.write(json.dumps({"status": "ok", "duration_sec": round(duration, 3)}).encode("utf-8"))
        except Exception as exc:
            self._log("WARN", f"[stream-duration] failed to fetch duration: {exc}")
            self._send_json(500, {"status": "error", "message": str(exc), "duration_sec": 0})


# =============================================================================
# Helper Utilities
# =============================================================================

def _clear_manual_pin_if_stream_changed_unlocked(title: Any, stream_url: Any) -> None:
    """Clear pinned manual subtitles if active media stream changes."""
    current_key = _stream_key(title, stream_url)
    pinned_key = str(manual_subtitle_pin.get("stream_key") or "")
    if pinned_key and pinned_key != current_key:
        manual_subtitle_pin["stream_key"] = ""
        manual_subtitle_pin["filename"] = ""

    last_key = _stream_key(current_stream.get("title"), current_stream.get("stream_url"))
    if last_key and last_key != current_key:
        manual_subtitle_candidates.clear()


def _is_bridge_local_url(url: Any) -> bool:
    """Check if given URL points to this local bridge server."""
    value = str(url or "").strip()
    if not value:
        return False
    try:
        parsed = urllib.parse.urlparse(value)
        host = (parsed.hostname or "").lower()
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except Exception:
        return bool(re.match(r"^https?://(?:localhost|127\.0\.0\.1|\[::1\]):7000(?:/|$)", value, flags=re.IGNORECASE))
    return port == PORT and host in {"localhost", "127.0.0.1", "::1"}


