# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     __VERSION__
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
"""
Subdl Subtitle Provider for Multi-Language Media Subtitles.
"""

from __future__ import annotations

import hashlib
import io
import re
from typing import Any
import unicodedata
import zipfile

try:
    import requests as _requests
except ImportError:
    _requests = None

from core.config import load_subdl_languages, load_tmdb_api_key
from subtitle_providers.jimaku import JimakuBridge


class SubdlProvider:
    """Subtitle provider querying Subdl API for movies and TV shows across 10+ languages."""

    def __init__(self, api_key: str) -> None:
        self.api_key: str = api_key

    def search(
        self,
        clean_query: str,
        requested_season: int | None = None,
        requested_episode: int | None = None,
    ) -> list[dict[str, Any]]:
        """
        Search Subdl API for subtitle candidates matching media title and season/episode.

        Workflow:
        1. Resolve TMDB ID for given clean query.
        2. Query Subdl API with user-configured target languages.
        3. Parse release names, season, and episode numbers.
        4. Return candidate dictionaries for selection or automatic download.
        """
        if not _requests:
            raise RuntimeError("requests is not available")

        tmdb_api_key = load_tmdb_api_key()
        tmdb_id: int | None = None
        is_tv: bool = True

        if tmdb_api_key:
            url = "https://api.themoviedb.org/3/search/multi"
            params = {
                "api_key": tmdb_api_key,
                "query": clean_query,
                "page": 1,
                "include_adult": "true",
            }
            try:
                r = _requests.get(url, params=params, timeout=10)
                if r.status_code == 200:
                    results = r.json().get("results", [])
                    valid = [res for res in results if res.get("media_type") in ("tv", "movie")]
                    valid.sort(key=lambda x: x.get("popularity", 0), reverse=True)
                    if valid:
                        tmdb_id = valid[0].get("id")
                        is_tv = valid[0].get("media_type") == "tv"
            except Exception:
                pass

        if not tmdb_id:
            raise ValueError("Could not find IMDB ID for the title")

        subdl_langs = load_subdl_languages()
        subdl_url = "https://api.subdl.com/api/v1/subtitles"
        subdl_params: dict[str, Any] = {
            "api_key": self.api_key,
            "tmdb_id": tmdb_id,
            "type": "tv" if is_tv else "movie",
            "languages": subdl_langs,
            "subs_per_page": 20,
        }

        if is_tv and requested_season:
            subdl_params["season_number"] = requested_season

        r = _requests.get(subdl_url, params=subdl_params, timeout=15)
        if r.status_code != 200:
            raise ValueError(f"Subdl API error: {r.status_code}")

        subdl_data = r.json()
        if not subdl_data.get("status"):
            raise ValueError("Subdl API returned no status")

        subtitles = subdl_data.get("subtitles", [])
        candidates: list[dict[str, Any]] = []

        for sub in subtitles:
            lang = sub.get("language", "Unknown")
            release_name = sub.get("release_name", "Unknown Release")
            url_path = sub.get("url")
            if not url_path:
                continue
            full_url = f"https://dl.subdl.com{url_path}" if url_path.startswith("/subtitle") else url_path
            filename = f"[{lang}] {release_name}.zip"
            candidate_id = hashlib.sha1(f"subdl|{filename}|{full_url}".encode("utf-8", errors="ignore")).hexdigest()[:16]

            clean_filename = unicodedata.normalize("NFKC", filename)
            compact_name = re.sub(r"[^a-zA-Z0-9]", "", clean_filename)
            fallback_match = re.search(r"s(\d{1,2})e(\d{1,4})", compact_name, re.IGNORECASE)

            extracted_ep = JimakuBridge._extract_episode_from_filename(clean_filename)
            extracted_se = JimakuBridge._extract_season_from_text(clean_filename)

            if fallback_match:
                if extracted_ep is None:
                    extracted_ep = int(fallback_match.group(2))
                if extracted_se is None:
                    extracted_se = int(fallback_match.group(1))

            real_episode = extracted_ep or requested_episode
            real_season = extracted_se or requested_season

            candidates.append({
                "id": candidate_id,
                "entry_id": tmdb_id,
                "entry_name": clean_query,
                "filename": filename,
                "url": full_url,
                "season": real_season,
                "episode": real_episode,
                "_subdl": True,
            })

        return candidates

    def download(
        self,
        url: str,
        current_ep: int | None = None,
        target_filename: str | None = None,
    ) -> tuple[bytes | None, str | list[str]]:
        """
        Download and extract subtitle archive (.zip) from Subdl.

        Returns (srt_bytes, filename) if matched, or (None, srt_files_list) for manual candidate selection.
        """
        if not _requests:
            raise RuntimeError("requests is not available")

        r = _requests.get(url, timeout=15)
        r.raise_for_status()

        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            srt_files = [name for name in z.namelist() if name.lower().endswith(".srt")]
            if not srt_files:
                raise ValueError("No .srt found in Subdl ZIP")

            target_srt: str | None = None
            if target_filename and target_filename in srt_files:
                target_srt = target_filename
            elif not target_filename and current_ep is not None:
                for name in srt_files:
                    ep = JimakuBridge._extract_episode_from_filename(name)
                    if ep == current_ep:
                        target_srt = name
                        break

            if not target_srt:
                return None, srt_files

            srt_bytes = z.read(target_srt)
            return srt_bytes, target_srt

