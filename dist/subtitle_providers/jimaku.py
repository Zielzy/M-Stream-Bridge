# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     3.1.0
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
from __future__ import annotations
import logging
import os
import re
import threading
from typing import Any
import urllib.parse
try:
    import requests as _requests
    REQUESTS_AVAILABLE = True
except ImportError:
    _requests = None
    REQUESTS_AVAILABLE = False
from core.config import get_config_path, load_tmdb_api_key, get_tmdb_endpoint
from core.state import STATE_LOCK, current_stream, manual_subtitle_pin, srt_store
from utils.title_parser import SITES_RE, clean_media_title
LOGGER = logging.getLogger('mstream_bridge')

def _is_subtitle_like_url(url: Any) -> bool:
    value = str(url or '').strip().lower()
    if not value:
        return False
    return bool(re.search('/(?:subtitles?|captions?|cc)(?:/|$)|(?:^|[_\\-.])sub(?:[_\\-.]|$)|(?:^|[_\\-.])(?:eng|jpn|japanese|ja)(?:[_\\-.]sub|[_\\-.]cc)|\\.(?:srt|vtt|ass|ssa)(?:$|[?#])|(?:^|[?&])(?:subtitle|caption|sub|cc)=', value))

def _stream_key(title: Any, stream_url: Any) -> str:
    normalized_title = re.sub('\\s+', ' ', str(title or '')).strip()
    normalized_url = str(stream_url or '').strip()
    if not normalized_url:
        return ''
    return f'{normalized_title}||{normalized_url}'

class JimakuBridge:
    ROMAJI_SEASON_MAP: dict[str, int] = {'ichi': 1, 'ni': 2, 'san': 3, 'yon': 4, 'go': 5, 'roku': 6, 'nana': 7, 'hachi': 8, 'kyuu': 9, 'juu': 10}
    ROMAJI_SEASON_PATTERN: re.Pattern[str] = re.compile('\\b(ichi|ni|san|yon|go|roku|nana|hachi|kyuu|juu)\\s*[- ]?no\\s*[- ]?shou\\b', re.IGNORECASE)
    STANDALONE_NOISE_RE: re.Pattern[str] = re.compile('^(?:comments?|discussions?|(?:ep|episode)\\.?\\s*\\d+)$', re.IGNORECASE)
    _TECHNICAL_STREAM_PREFIXES: tuple[str, ...] = ('stream', 'index', 'chunk', 'segment', 'seg', 'video', 'audio', 'track', 'part', 'master', 'playlist', 'manifest', 'rendition', 'media', 'frag', 'init')

    def __init__(self, api_key: str, proxy_base_url: str='http://127.0.0.1:7000', poll_interval_sec: int=5) -> None:
        if not REQUESTS_AVAILABLE:
            raise RuntimeError('pip install requests')
        self.api_key: str = api_key.strip()
        self.proxy_base_url: str = proxy_base_url.rstrip('/')
        self.poll_interval_sec: int = max(1, int(poll_interval_sec))
        self.last_processed_title: str = ''
        self._last_seen_updated_at: str = ''
        self._auth_invalid: bool = False
        self._stop_event: threading.Event = threading.Event()
        self._thread: threading.Thread | None = None
        self._session: _requests.Session = _requests.Session()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._poll_loop, name='JimakuBridgePoll', daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)

    def _poll_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._poll_once()
            except Exception as exc:
                LOGGER.error('[JIMAKU] polling error: %s', exc)
            self._stop_event.wait(self.poll_interval_sec)

    def _poll_once(self) -> None:
        if self._auth_invalid:
            return
        url = f'{self.proxy_base_url}/api/current-stream'
        try:
            resp = self._session.get(url, timeout=5)
            resp.raise_for_status()
            payload: dict[str, Any] = resp.json() if resp.content else {}
        except Exception as exc:
            LOGGER.error('[JIMAKU] failed to fetch current-stream: %s', exc)
            return
        if not payload.get('has_stream'):
            self._last_seen_updated_at = ''
            return
        stream = payload.get('stream') or {}
        updated_at = str(stream.get('updated_at') or '').strip()
        if updated_at and updated_at == self._last_seen_updated_at:
            return
        title = str(stream.get('title') or '').strip()
        stream_url = str(stream.get('stream_url') or '').strip()
        page_episode_raw = stream.get('episode')
        detected_episode_raw = stream.get('detected_episode')
        page_episode = page_episode_raw if isinstance(page_episode_raw, int) else None
        detected_episode = detected_episode_raw if isinstance(detected_episode_raw, int) else None
        if not title:
            LOGGER.debug('[JIMAKU] stream title is empty')
            return
        LOGGER.info('[JIMAKU] poll | title=%s | page_ep=%s | detected_ep=%s | last_processed=%s', title, page_episode, detected_episode, self.last_processed_title)
        with STATE_LOCK:
            pinned_key = str(manual_subtitle_pin.get('stream_key') or '')
            current_key = _stream_key(title, stream_url)
            if pinned_key and pinned_key == current_key:
                self._last_seen_updated_at = updated_at
                return
            if pinned_key and pinned_key != current_key:
                manual_subtitle_pin['stream_key'] = ''
                manual_subtitle_pin['filename'] = ''
        ep_val = detected_episode if detected_episode is not None else page_episode if page_episode is not None else 'unknown'
        dedup_key = f'{title}||{ep_val}'
        if dedup_key == self.last_processed_title:
            self._last_seen_updated_at = updated_at
            return
        self._last_seen_updated_at = updated_at
        title_candidates_raw = stream.get('title_candidates') or []
        title_candidates: list[str] = []
        if isinstance(title_candidates_raw, list):
            for item in title_candidates_raw:
                if isinstance(item, str):
                    title_candidates.append(item)
                elif isinstance(item, dict):
                    val = item.get('value') or item.get('title')
                    if val:
                        title_candidates.append(str(val))
        try:
            self._process_title(title, stream_url, page_episode, detected_episode, title_candidates)
        except Exception as exc:
            if str(exc) == 'jimaku_429':
                self.last_processed_title = dedup_key
                return
            LOGGER.error('[JIMAKU] process error: %s', exc)

    def _mark_auth_invalid(self, source: str) -> None:
        if self._auth_invalid:
            return
        self._auth_invalid = True
        LOGGER.error('[JIMAKU] Jimaku API key is invalid or expired (401) during %s', source)
        LOGGER.error('[JIMAKU] Save a new API key in %s, then restart M-Stream Bridge.', get_config_path())

    def _extract_episode_from_stream_url(self, stream_url: str) -> int | None:
        url = str(stream_url or '').strip()
        if not url:
            return None
        try:
            path = urllib.parse.urlparse(url).path
            filename = os.path.basename(path).lower()
            stem = re.sub('\\.\\w{2,5}$', '', filename)
            if stem.startswith(self._TECHNICAL_STREAM_PREFIXES):
                return None
        except Exception:
            pass
        patterns = ['[\\/\\-_](?:episode|ep)[\\/\\-_]?(\\d{1,4})(?:[\\/\\-_?#]|$)', '[\\/\\-_]e(\\d{1,4})(?:[\\/\\-_?#]|$)', '[?&]ep(?:isode)?=(\\d{1,4})(?:&|$)', '/(\\d{1,4})/(?:index|master|playlist)\\.m3u8', '/(\\d{1,4})/[^/?#]+\\.m3u8(?:\\?|$)', '[\\/\\-_](\\d{1,4})(?:\\.m3u8|\\.mp4|\\.ts)(?:\\?|$)', 'S\\d{1,2}E(\\d{1,4})']
        for pattern in patterns:
            match = re.search(pattern, url, flags=re.IGNORECASE)
            if not match:
                continue
            try:
                ep = int(match.group(1))
            except (TypeError, ValueError):
                continue
            if 1 <= ep <= 2000:
                return ep
        return None

    def _process_title(self, title: str, stream_url: str='', page_episode: int | None=None, detected_episode: int | None=None, title_candidates: list[Any] | None=None) -> None:
        clean_title, title_episode = self._parse_title(title)
        stream_url_episode = None if _is_subtitle_like_url(stream_url) else self._extract_episode_from_stream_url(stream_url)
        if _is_subtitle_like_url(stream_url):
            detected_episode = None
        episode_num = page_episode if page_episode is not None else detected_episode if detected_episode is not None else title_episode if title_episode is not None else stream_url_episode
        ep_val = detected_episode if detected_episode is not None else page_episode if page_episode is not None else 'unknown'
        dedup_key = f'{title}||{ep_val}'
        season_num: int | None = self._extract_season_from_text(title)
        if season_num is None:
            season_num = self._extract_season_from_text(clean_title)
        if season_num is None:
            season_num = self._extract_season_from_text(stream_url)
        if season_num is None:
            with STATE_LOCK:
                _raw_season = current_stream.get('season')
            try:
                _s = int(_raw_season)
                season_num = _s if _s > 0 else None
            except (TypeError, ValueError):
                season_num = None
        if episode_num is not None or season_num is not None:
            with STATE_LOCK:
                if episode_num is not None and (not current_stream.get('episode')):
                    LOGGER.info('[STATE] episode changed | %s -> %s | reason=jimaku_title_parse', current_stream.get('episode'), episode_num)
                    current_stream['episode'] = episode_num
                if season_num is not None and (not current_stream.get('season')):
                    current_stream['season'] = season_num
        if episode_num is None:
            LOGGER.info('[JIMAKU] bail-out: episode not detected | title=%s | page_ep=%s | detected_ep=%s | title_ep=%s | url_ep=%s', title, page_episode, detected_episode, title_episode, stream_url_episode)
            self.last_processed_title = dedup_key
            return
        LOGGER.info('[JIMAKU] processing title=%s | query=%s | ep=%s | season=%s | source=%s', title, clean_title, episode_num, season_num, 'page' if page_episode is not None else 'url' if detected_episode is not None else 'title' if title_episode is not None else 'stream_url')
        entry = None
        file_info = None
        saw_entry_without_file = False
        tried_queries: set[str] = set()
        query_candidates = self._build_query_candidates(clean_title, title_candidates, season_num)

        def try_queries(queries: list[str], matched_log: str) -> bool:
            nonlocal entry, file_info, saw_entry_without_file
            for query in queries:
                if query in tried_queries:
                    continue
                tried_queries.add(query)
                found_entry = self._search_jimaku(query)
                if not found_entry:
                    continue
                if query != clean_title:
                    LOGGER.debug(matched_log, query)
                found_file = self._get_best_srt(int(found_entry['id']), episode_num, season_num)
                if found_file:
                    entry = found_entry
                    file_info = found_file
                    return True
                saw_entry_without_file = True
                LOGGER.warning('[JIMAKU] matched entry has no requested episode, trying next query | query=%s | entry_id=%s ep=%s season=%s', query, found_entry['id'], episode_num, season_num)
            return False
        if not try_queries(query_candidates[:8], '[JIMAKU] fallback query matched: %s'):
            external_search_queries = []
            for q in query_candidates[:4]:
                if len(q) < 50 and q not in external_search_queries:
                    if not self.STANDALONE_NOISE_RE.match(q.strip()):
                        external_search_queries.append(q)
            for tc in title_candidates or []:
                tc_str = ''
                if isinstance(tc, str):
                    tc_str = tc
                elif isinstance(tc, dict):
                    tc_str = str(tc.get('value') or tc.get('title') or '')
                if tc_str and len(tc_str) > 2 and (tc_str not in external_search_queries):
                    if not re.search('(?i)\\b(watch|free|online|stream|download|hd|subbed|dubbed)\\b', tc_str):
                        if not self.STANDALONE_NOISE_RE.match(tc_str.strip()):
                            external_search_queries.append(tc_str)
            external_aliases = self._search_external_title_aliases(external_search_queries, validation_title=clean_title)
            if external_aliases:
                if not try_queries(external_aliases, '[JIMAKU] external alias matched: %s'):
                    external_queries = self._build_query_candidates(clean_title, external_aliases, season_num, allow_unrelated_candidates=True)
                    try_queries(external_queries[:8], '[JIMAKU] external alias candidate matched: %s')
        if not entry:
            if saw_entry_without_file:
                LOGGER.warning('[JIMAKU] srt file not found after trying related queries | ep=%s season=%s', episode_num, season_num)
                self.last_processed_title = dedup_key
                return
            LOGGER.warning('[JIMAKU] entry not found for query: %s', clean_title)
            self.last_processed_title = dedup_key
            return
        if not file_info:
            LOGGER.warning('[JIMAKU] srt file not found | entry_id=%s ep=%s season=%s', entry['id'], episode_num, season_num)
            self.last_processed_title = dedup_key
            return
        try:
            srt_bytes = self._download_srt(file_info['url'])
        except Exception as exc:
            LOGGER.error('[JIMAKU] failed to download srt: %s', exc)
            self.last_processed_title = dedup_key
            return
        self._update_proxy(file_info['name'], srt_bytes, title=title, episode=episode_num)
        self.last_processed_title = dedup_key

    def _parse_title(self, title: str) -> tuple[str, int | None]:
        text = (title or '').strip()
        ep_patterns = ['S\\d{1,2}E(?P<ep>\\d{1,4})\\b', '\\d{1,2}x(?P<ep>\\d{1,4})\\b', 'Ep(?:is[o0]de|s)?\\.?\\s*(?P<ep>\\d{1,4})\\b', '[Ee](?P<ep>\\d{1,4})(?:[^a-zA-Z]|$)', '(?<!\\d)(?P<ep>\\d{1,4})(?!\\d)(?=\\s*(?:sub|dub|end|$|\\|))']
        episode_num: int | None = None
        for pattern in ep_patterns:
            match = re.search(pattern, text, flags=re.IGNORECASE)
            if not match:
                continue
            ep = int(match.group('ep'))
            if not 1 <= ep <= 2000:
                continue
            before = text[:match.start()]
            if re.search('\\b(?:season|part|cour|s)\\s*$', before, flags=re.IGNORECASE):
                continue
            episode_num = ep
            text = (text[:match.start()] + text[match.end():]).strip()
            break
        text = clean_media_title(text)
        text = re.sub('\\s*\\((?:19|20)\\d{2}\\)', '', text).strip()
        text = re.sub('\\b(?:english|eng)?\\s*(?:subtitle|sub|dub)\\b\\s*(?:indonesia|indo|eng|english)?', '', text, flags=re.IGNORECASE).strip()
        text = re.sub('\\b(?:watch|online|free|stream(?:ing)?|nonton|episode\\s+terbaru|in\\s+hd|hd|full\\s+movie(?:s)?|on\\s+plex)\\b', '', text, flags=re.IGNORECASE)
        text = SITES_RE.sub('', text)
        text = re.sub('\\banime\\b\\s*$', '', text, flags=re.IGNORECASE)
        text = re.sub('\\s*[-|:]+\\s*$', '', text).strip()
        text = re.sub('\\s+', ' ', text).strip()
        result = text or 'Untitled'
        LOGGER.debug('[JIMAKU] _parse_title | raw_title=%r | final_query=%r', title, result)
        return (result, episode_num)

    def _clean_display_title(self, raw: str) -> str:
        return clean_media_title(raw)

    def _is_related_page_title_candidate(self, primary_title: str, candidate_title: str) -> bool:
        primary, _primary_ep = self._parse_title(primary_title)
        candidate, _candidate_ep = self._parse_title(candidate_title)
        if not primary or not candidate:
            return False
        if primary.lower() == candidate.lower():
            return True

        def tokens(value: str) -> set[str]:
            ignored = {'the', 'and', 'for', 'with', 'that', 'this', 'into', 'from', 'got', 'no', 'wa', 'na', 'ni', 'wo', 'ga', 'de', 'to', 'in', 'of', 'is', 'it', 'my', 'me', 'he', 'as', 'at', 'by', 'or', 'season', 'episode', 'ep', 'watch', 'anime'}
            return {token for token in re.findall('[a-z0-9]+', value.lower()) if len(token) >= 3 and token not in ignored}
        primary_tokens = tokens(primary)
        candidate_tokens = tokens(candidate)
        if primary_tokens and candidate_tokens:
            overlap = len(primary_tokens & candidate_tokens)
            if overlap >= 2 or overlap / max(1, min(len(primary_tokens), len(candidate_tokens))) >= 0.67:
                return True
        return self._title_similarity(primary, candidate) >= 0.72

    def _build_query_candidates(self, clean_title: str, title_candidates: list[Any] | None=None, season_num: int | None=None, *, allow_unrelated_candidates: bool=False) -> list[str]:
        candidates: list[str] = []

        def add(value: str) -> None:
            v = re.sub('\\s+', ' ', value).strip(' -|:')
            if not v:
                return
            if v not in candidates:
                candidates.append(v)
            if v.title() not in candidates:
                candidates.append(v.title())
            if v.upper() not in candidates:
                candidates.append(v.upper())

        def ordinal(value: str) -> str:
            try:
                n = int(value)
            except (TypeError, ValueError):
                return value
            if 10 <= n % 100 <= 20:
                suffix = 'th'
            else:
                suffix = {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')
            return f'{n}{suffix}'
        raw_values: list[str] = [clean_title]
        for delimiter in [',', '|', '-', ':']:
            if delimiter in clean_title:
                for part in clean_title.split(delimiter):
                    part = part.strip()
                    if part and len(part) >= 3 and (part not in raw_values):
                        raw_values.append(part)
        for value in title_candidates or []:
            val_str = ''
            if isinstance(value, str):
                val_str = value
            elif isinstance(value, dict):
                val_str = str(value.get('value') or value.get('title') or '')
            if val_str:
                if allow_unrelated_candidates or self._is_related_page_title_candidate(clean_title, val_str):
                    raw_values.append(val_str)
                else:
                    LOGGER.debug('[JIMAKU] skipped unrelated page title candidate: %s', val_str)
        season_variants: list[str] = []
        base_variants_out: list[str] = []
        for raw in raw_values:
            raw_clean = re.sub('\\s*·.*$', '', raw).strip(' -|:')
            raw_clean = SITES_RE.sub('', raw_clean).strip(' -|:')
            if raw_clean and len(raw_clean) >= 4 and (not self.STANDALONE_NOISE_RE.match(raw_clean)):
                add(raw_clean)
            parsed, _episode = self._parse_title(raw)
            cleaned_title = JimakuBridge.ROMAJI_SEASON_PATTERN.sub('', parsed)
            cleaned_title = re.sub('\\s+', ' ', cleaned_title)
            cleaned_title = re.sub('\\s*[:\\-–]+\\s*$', '', cleaned_title).strip(' -_:')
            base_variants = [cleaned_title, parsed, re.sub('\\banime\\b\\s*$', '', cleaned_title, flags=re.IGNORECASE), re.sub('\\bseason\\s*\\d+\\b', '', cleaned_title, flags=re.IGNORECASE), re.sub('\\bs\\d{1,2}\\b', '', cleaned_title, flags=re.IGNORECASE), re.sub('\\bpart\\s*\\d+\\b', '', cleaned_title, flags=re.IGNORECASE), re.sub('\\b(?:watch|online|free)\\b', '', cleaned_title, flags=re.IGNORECASE), re.sub('\\bin\\s+hd\\b', '', cleaned_title, flags=re.IGNORECASE), re.sub('\\bhd\\b', '', cleaned_title, flags=re.IGNORECASE), re.sub('^\\s*anime\\s+', '', parsed, flags=re.IGNORECASE), re.sub('\\bseason\\s*\\d+\\b', '', re.sub('^\\s*anime\\s+', '', parsed, flags=re.IGNORECASE), flags=re.IGNORECASE)]
            for value in base_variants:
                v = re.sub('\\s+', ' ', value).strip(' -|:')
                if not v:
                    continue
                season_match = re.search('\\bseason\\s*(\\d+)\\b', v, flags=re.IGNORECASE)
                if season_match:
                    match_num = season_match.group(1)
                    season_variants.append(v)
                    season_variants.append(re.sub('\\bseason\\s*\\d+\\b', f'{ordinal(match_num)} Season', v, flags=re.IGNORECASE))
                    season_variants.append(re.sub('\\bseason\\s*\\d+\\b', str(match_num), v, flags=re.IGNORECASE))
                    base_variants_out.append(re.sub('\\bseason\\s*\\d+\\b', '', v, flags=re.IGNORECASE))
                else:
                    base_variants_out.append(v)
                    if season_num is not None and (not re.search('\\b\\d+(?:st|nd|rd|th)\\s+season\\b', v, flags=re.IGNORECASE)):
                        season_variants.append(f'{v} Season {season_num}')
                        season_variants.append(f'{v} {ordinal(str(season_num))} Season')
                        season_variants.append(f'{v} {season_num}')
        for value in season_variants:
            add(value)
        for value in base_variants_out:
            add(value)
        return candidates[:30]

    def _search_external_title_aliases(self, queries: list[str], validation_title: str='') -> list[str]:
        if not queries or not REQUESTS_AVAILABLE:
            return []
        tmdb_api_key = load_tmdb_api_key()
        global_best_item = None
        global_best_score = 0.0
        for query in queries:
            if len(query) > 60 or ',' in query:
                continue
            search_query = JimakuBridge.ROMAJI_SEASON_PATTERN.sub('', query)
            search_query = re.sub('\\bseason\\s*\\d+\\b', '', search_query, flags=re.IGNORECASE)
            search_query = re.sub('\\bpart\\s*\\d+\\b', '', search_query, flags=re.IGNORECASE)
            search_query = re.sub('\\s+', ' ', search_query).strip(' -|:')
            if not search_query:
                search_query = query
            if len(search_query) < 2:
                continue
            if self.STANDALONE_NOISE_RE.match(search_query.strip()):
                continue
            try:
                search_url, search_params = get_tmdb_endpoint('search/multi')
                LOGGER.info(f'[JIMAKU] Querying TMDB via https://{urllib.parse.urlparse(search_url).netloc} for {search_query!r}')
                req_params = dict(search_params)
                req_params.update({'query': search_query, 'include_adult': 'false'})
                if tmdb_api_key and 'api_key' not in req_params:
                    req_params['api_key'] = tmdb_api_key
                resp = self._session.get(search_url, params=req_params, timeout=10)
            except Exception:
                continue
            if resp.status_code >= 400:
                continue
            try:
                payload = resp.json()
            except ValueError:
                continue
            items = payload.get('results') if isinstance(payload, dict) else []
            if not isinstance(items, list) or not items:
                continue
            for idx, item in enumerate(items):
                if not isinstance(item, dict) or item.get('media_type') not in ('movie', 'tv'):
                    continue
                item_titles: list[str] = []
                for key in ('name', 'original_name', 'title', 'original_title'):
                    value = item.get(key)
                    if isinstance(value, str) and value.strip():
                        item_titles.append(value.strip())
                comparable_titles = [value for value in item_titles]
                item_score = max([self._title_similarity(search_query, value) for value in comparable_titles], default=0.0)
                if idx == 0 and item_score < 0.55:
                    tmdb_id = item.get('id')
                    media_type = item.get('media_type')
                    if tmdb_id and media_type:
                        try:
                            aka_url, aka_params = get_tmdb_endpoint(f'{media_type}/{tmdb_id}/alternative_titles')
                            req_aka_params = dict(aka_params)
                            if tmdb_api_key and 'api_key' not in req_aka_params:
                                req_aka_params['api_key'] = tmdb_api_key
                            aka_resp = self._session.get(aka_url, params=req_aka_params, timeout=10)
                            if aka_resp.status_code < 400:
                                aka_data = aka_resp.json()
                                aka_list = aka_data.get('titles') or aka_data.get('results') or []
                                best_aka_score = max([self._title_similarity(search_query, str(aka.get('title') or '')) for aka in aka_list if isinstance(aka, dict)], default=0.0)
                                item_score = max(item_score, best_aka_score)
                        except Exception:
                            pass
                if validation_title and validation_title != search_query:
                    val_parts = [p.strip() for p in re.split('[,|]', validation_title) if p.strip()]
                    if not val_parts:
                        val_parts = [validation_title]
                    val_score = 0.0
                    for part in val_parts:
                        part_score = max([self._title_similarity(part, value) for value in comparable_titles], default=0.0)
                        val_score = max(val_score, part_score)
                    if val_score > 0.8:
                        item_score = max(item_score, val_score)
                    elif val_score < 0.35:
                        item_score *= 0.5
                if item_score > global_best_score:
                    global_best_score = item_score
                    global_best_item = item
                elif item_score == global_best_score and global_best_item and (item_score > 0.55):
                    if item.get('popularity', 0.0) > global_best_item.get('popularity', 0.0):
                        global_best_item = item
        if global_best_score < 0.55 or not global_best_item:
            return []
        aliases: list[str] = []

        def add_alias(value: Any) -> None:
            if not isinstance(value, str):
                return
            v = re.sub('\\s+', ' ', value).strip(' -|:')
            if not v:
                return
            for variant in (v, v.title(), v.upper()):
                if variant not in aliases:
                    aliases.append(variant)
        for key in ('name', 'original_name', 'title', 'original_title'):
            add_alias(global_best_item.get(key))
        suffix_pattern = re.compile('\\s*(?:Film\\b.*|Movie\\b.*|Recap\\b.*|OVA\\b.*|Special\\b.*|Episode\\s+of\\b.*|3D2Y\\b.*|TV\\s+Special\\b.*|:\\s+.*)\\s*$', re.IGNORECASE)
        for raw_alias in list(aliases):
            base = suffix_pattern.sub('', raw_alias).strip()
            if base and len(base) >= 3 and (base.lower() != raw_alias.lower()):
                add_alias(base)
        return aliases[:20]

    def _search_jimaku_candidates(self, query: str, max_items: int=5) -> list[dict[str, Any]]:
        url = 'https://jimaku.cc/api/entries/search'
        headers = {'Authorization': self.api_key}
        params = {'query': query, 'anime': 'true'}
        for _attempt in range(2):
            try:
                resp = self._session.get(url, headers=headers, params=params, timeout=15)
            except Exception as exc:
                LOGGER.error('[JIMAKU] search request failed: %s', exc)
                return []
            if resp.status_code == 429:
                LOGGER.warning('[JIMAKU] search rate limited (429), skipping retry')
                raise RuntimeError('jimaku_429')
            if resp.status_code == 401:
                self._mark_auth_invalid('search')
                return []
            if resp.status_code >= 400:
                LOGGER.warning('[JIMAKU] search failed status=%s', resp.status_code)
                return []
            try:
                data = resp.json()
            except ValueError:
                LOGGER.error('[JIMAKU] search response did not return valid json')
                return []
            entries: list[dict[str, Any]] = []
            if isinstance(data, list):
                entries = [x for x in data if isinstance(x, dict)]
            elif isinstance(data, dict):
                candidates = data.get('entries') or data.get('results') or data.get('data') or []
                if isinstance(candidates, list):
                    entries = [x for x in candidates if isinstance(x, dict)]
            out: list[dict[str, Any]] = []
            for item in entries:
                entry_id = item.get('id')
                if isinstance(entry_id, str) and entry_id.isdigit():
                    entry_id = int(entry_id)
                if not isinstance(entry_id, int):
                    continue
                out.append({'id': entry_id, 'english_name': str(item.get('english_name') or '').strip(), 'japanese_name': str(item.get('japanese_name') or '').strip()})
                if len(out) >= max_items:
                    break
            return out
        return []

    @staticmethod
    def _title_similarity(query: str, candidate_name: str) -> float:
        from difflib import SequenceMatcher
        q_raw = str(query or '').strip()
        c_raw = str(candidate_name or '').strip()
        if not q_raw or not c_raw:
            return 0.0

        def _normalize(text: str) -> str:
            text = re.sub('[^\\w\\s]', ' ', text.lower())
            text = re.sub('\\s+', ' ', text).strip()
            return text
        q_norm = _normalize(q_raw)
        c_norm = _normalize(c_raw)
        ignored = {'the', 'and', 'for', 'with', 'that', 'this', 'into', 'from', 'got', 'no', 'wa', 'na', 'ni', 'wo', 'ga', 'de', 'to', 'in', 'of', 'is', 'it', 'my', 'me', 'he', 'as', 'at', 'by', 'or'}

        def _tokenize(text: str) -> set[str]:
            return {t for t in re.findall('[a-z0-9]+', text) if len(t) >= 2 and t not in ignored}
        q_tokens = _tokenize(q_norm)
        c_tokens = _tokenize(c_norm)
        token_score = 0.0
        if q_tokens and c_tokens:
            overlap = len(q_tokens & c_tokens)
            precision = overlap / len(c_tokens)
            recall = overlap / len(q_tokens)
            if precision + recall > 0:
                token_score = 2 * precision * recall / (precision + recall)
        seq_score = SequenceMatcher(None, q_norm, c_norm).ratio()
        substr_score = 0.0
        if len(q_norm) >= 4 and len(c_norm) >= 4:
            if q_norm == c_norm:
                substr_score = 1.0
            elif q_norm in c_norm or c_norm in q_norm:
                len_ratio = min(len(q_norm), len(c_norm)) / max(len(q_norm), len(c_norm))
                if c_norm.startswith(q_norm) or q_norm.startswith(c_norm):
                    substr_score = 0.7 + 0.25 * len_ratio
                else:
                    substr_score = 0.45 + 0.3 * len_ratio
            else:
                significant = [t for t in q_tokens if len(t) >= 4]
                if significant:
                    found = sum((1 for t in significant if t in c_norm))
                    substr_score = found / len(significant) * 0.55
        jp_score = 0.0
        q_jp = re.findall('[\\u3040-\\u30ff\\u3400-\\u9fff]+', q_raw)
        c_jp = re.findall('[\\u3040-\\u30ff\\u3400-\\u9fff]+', c_raw)
        if q_jp and c_jp:
            q_jp_str = ''.join(q_jp)
            c_jp_str = ''.join(c_jp)
            if q_jp_str == c_jp_str:
                jp_score = 1.0
            elif q_jp_str in c_jp_str or c_jp_str in q_jp_str:
                len_ratio = min(len(q_jp_str), len(c_jp_str)) / max(len(q_jp_str), len(c_jp_str))
                jp_score = 0.65 + 0.3 * len_ratio
            else:
                jp_score = SequenceMatcher(None, q_jp_str, c_jp_str).ratio() * 0.9
        return max(token_score, seq_score, substr_score, jp_score)

    def _search_jimaku(self, query: str) -> dict[str, Any] | None:
        entries = self._search_jimaku_candidates(query, max_items=15)
        if not entries:
            return None
        SIMILARITY_THRESHOLD = 0.7
        best_entry = None
        best_score = 0.0
        for entry in entries:
            eng = entry.get('english_name') or ''
            jpn = entry.get('japanese_name') or ''
            score_eng = self._title_similarity(query, eng) if eng else 0.0
            score_jpn = self._title_similarity(query, jpn) if jpn else 0.0
            score = max(score_eng, score_jpn)
            LOGGER.debug('[JIMAKU] candidate id=%s | eng=%s | jpn=%s | similarity=%.2f', entry.get('id'), eng, jpn, score)
            if score > best_score:
                best_score = score
                best_entry = entry
        if best_score < SIMILARITY_THRESHOLD:
            return None
        LOGGER.debug('[JIMAKU] accepted entry id=%s | similarity=%.2f | name=%s', best_entry.get('id'), best_score, best_entry.get('english_name') or best_entry.get('japanese_name'))
        return best_entry

    def _get_srt_files(self, entry_id: int, episode: int | None=None) -> list[dict[str, str]]:
        url = f'https://jimaku.cc/api/entries/{entry_id}/files'
        headers = {'Authorization': self.api_key}
        params = {'episode': str(episode)} if episode is not None else {}
        try:
            resp = self._session.get(url, headers=headers, params=params, timeout=15)
        except Exception as exc:
            LOGGER.error('[JIMAKU] files request failed: %s', exc)
            return []
        if resp.status_code == 401:
            self._mark_auth_invalid('files')
            return []
        if resp.status_code >= 400:
            LOGGER.warning('[JIMAKU] files failed status=%s', resp.status_code)
            return []
        try:
            data = resp.json()
        except ValueError:
            LOGGER.error('[JIMAKU] files response did not return valid json')
            return []
        files: list[dict[str, Any]] = []
        if isinstance(data, list):
            files = [x for x in data if isinstance(x, dict)]
        elif isinstance(data, dict):
            candidates = data.get('files') or data.get('results') or data.get('data') or []
            if isinstance(candidates, list):
                files = [x for x in candidates if isinstance(x, dict)]
        srt_files: list[dict[str, str]] = []
        for item in files:
            name = str(item.get('name') or '').strip()
            file_url = str(item.get('url') or '').strip()
            if not name.lower().endswith('.srt'):
                continue
            if not file_url:
                continue
            srt_files.append({'name': name, 'url': file_url})
        return srt_files

    def _get_best_srt(self, entry_id: int, episode: int, season: int | None=None) -> dict[str, str] | None:
        srt_files = self._get_srt_files(entry_id, episode=None)
        if season is not None:
            LOGGER.debug('[JIMAKU] fetching all files for season-aware lookup | entry_id=%s | season=%s | ep=%s | total_files=%s', entry_id, season, episode, len(srt_files))
        if not srt_files:
            return None
        if season is not None:
            files_with_season = [item for item in srt_files if self._extract_season_from_text(item['name']) is not None]
            files_without_season = [item for item in srt_files if self._extract_season_from_text(item['name']) is None]
            if files_with_season:
                season_matched = [item for item in files_with_season if self._extract_season_from_text(item['name']) == season]
                if season_matched:
                    LOGGER.debug('[JIMAKU] season filter applied | requested_season=%s | kept=%s+%s(no-season)/%s files', season, len(season_matched), len(files_without_season), len(srt_files))
                    srt_files = season_matched + files_without_season
                else:
                    LOGGER.warning('[JIMAKU] entry only contains other seasons (%s), requested season=%s | skipping entry', sorted(set((self._extract_season_from_text(item['name']) for item in files_with_season))), season)
                    if files_without_season:
                        srt_files = files_without_season
                    else:
                        return None
        files_with_episode = [item for item in srt_files if self._extract_episode_from_filename(item['name']) is not None]
        if files_with_episode:
            direct_matched = [item for item in files_with_episode if self._extract_episode_from_filename(item['name']) == episode]
            all_ep_nums = sorted(set((self._extract_episode_from_filename(item['name']) for item in files_with_episode)))
            small_eps = [n for n in all_ep_nums if n <= 50]
            large_eps = [n for n in all_ep_nums if n > 50]
            candidate_offsets = set()
            if small_eps and large_eps:
                offset = min(large_eps) - min(small_eps)
                if offset > 0:
                    candidate_offsets.add(offset)
            elif large_eps and (not small_eps):
                offset = min(large_eps) - 1
                if offset > 0:
                    candidate_offsets.add(offset)
            offset_matched = []
            used_offset = None
            for offset in sorted(candidate_offsets):
                absolute_ep = episode + offset
                offset_matched = [item for item in files_with_episode if self._extract_episode_from_filename(item['name']) == absolute_ep]
                if offset_matched:
                    used_offset = offset
                    break
            if offset_matched:
                LOGGER.debug('[JIMAKU] offset match found | requested_ep=%s | absolute_ep=%s | offset=%s | matches=%s', episode, episode + used_offset, used_offset, [item['name'] for item in offset_matched[:4]])
            seen_urls: set[str] = set()
            combined: list[dict[str, str]] = []
            for item in direct_matched + offset_matched:
                url = item.get('url', item.get('name', ''))
                if url not in seen_urls:
                    seen_urls.add(url)
                    combined.append(item)
            if not combined:
                LOGGER.warning('[JIMAKU] no srt filename matched requested episode | requested_ep=%s | all_eps=%s | candidates=%s', episode, all_ep_nums[:20], [item['name'] for item in files_with_episode[:8]])
                return None
            srt_files = combined
        srt_files.sort(key=lambda x: self._score_subtitle_file(x.get('name', '')), reverse=True)
        best = srt_files[0]
        LOGGER.debug('[JIMAKU] selected subtitle | file=%s | score=%s | total_candidates=%s', best.get('name', '?'), self._score_subtitle_file(best.get('name', '')), len(srt_files))
        return best

    @staticmethod
    def _score_subtitle_file(name: str) -> int:
        score = 0
        name_lower = (name or '').lower()
        if re.search('[\\u3040-\\u30ff\\u3400-\\u9fff]', name or ''):
            score += 40
        provider_scores = {'amazon': 6, 'abema': 4, 'netflix': 2, 'crunchyroll': 1, 'funimation': 1, 'hidive': 1, 'disney': 1}
        for provider, bonus in provider_scores.items():
            if provider in name_lower:
                score += 20 + bonus
                break
        if re.search('(?:^|[^a-z])(ja|jpn|japanese|ja-jp)(?:[^a-z]|$)', name_lower):
            score += 20
        if re.search('(?:^|[^a-z])(cc|sdh)(?:[^a-z]|$)', name_lower):
            score += 5
        if re.match('^\\[', name or ''):
            score -= 20
        if name_lower.endswith('.srt'):
            score += 2
        return score

    @staticmethod
    def _extract_episode_from_filename(name: str) -> int | None:
        import unicodedata
        text = unicodedata.normalize('NFKC', name or '')
        patterns = ['第\\s*(\\d{1,4})\\s*話?', '\\bS\\d{1,2}E(\\d{1,4})\\b', '\\bS\\d{1,2}\\s*[-_.]\\s*(\\d{1,4})\\b', '\\bSeason\\s*\\d{1,2}\\s*[-_.]\\s*(\\d{1,4})\\b', '\\b\\d{1,2}x(\\d{1,4})\\b', '(?:^|[^A-Za-z])E(\\d{1,4})(?:[^A-Za-z]|$)', '\\bEP(?:ISODE)?[\\s._-]*(\\d{1,4})\\b']
        for pattern in patterns:
            match = re.search(pattern, text, flags=re.IGNORECASE)
            if not match:
                continue
            try:
                value = int(match.group(1))
            except (TypeError, ValueError):
                continue
            if 1 <= value <= 2000:
                return value
        loose_patterns = ['[-._]\\s*(\\d{1,4})(?=\\s*(?:[._\\-\\[\\(]|$))']
        ignored_prefix_tokens = {'aac', 'ac3', 'eac3', 'flac', 'hevc', 'h264', 'h265', 'x264', 'x265', 'av1', 'mpeg', 'mpeg2', 'opus', 'vobsub'}
        ignored_values = {360, 480, 540, 720, 1080, 1440, 2160, 4320}
        for pattern in loose_patterns:
            for match in re.finditer(pattern, text, flags=re.IGNORECASE):
                try:
                    value = int(match.group(1))
                except (TypeError, ValueError):
                    continue
                if not 1 <= value <= 2000:
                    continue
                if value in ignored_values or 1900 <= value <= 2099:
                    continue
                prefix = text[:match.start()]
                prefix_tokens = [token.lower() for token in re.split('[^0-9A-Za-z]+', prefix) if token]
                if prefix_tokens and prefix_tokens[-1] in ignored_prefix_tokens:
                    continue
                return value
        return None

    @staticmethod
    def _extract_season_from_text(value: str) -> int | None:
        import unicodedata
        text = unicodedata.normalize('NFKC', str(value or ''))
        if '://' in text:
            try:
                parsed = urllib.parse.urlparse(text)
                text = parsed.path + ('?' + parsed.query if parsed.query else '')
            except Exception:
                pass
        patterns = ['\\bS(\\d{1,2})E\\d{1,4}\\b', '\\bS(?:eason)?[\\s._-]*(\\d{1,2})\\b', '\\b(\\d{1,2})(?:st|nd|rd|th)\\s+Season\\b']
        for pattern in patterns:
            match = re.search(pattern, text, flags=re.IGNORECASE)
            if not match:
                continue
            try:
                season = int(match.group(1))
            except (TypeError, ValueError):
                continue
            if 1 <= season <= 50:
                return season
        match = JimakuBridge.ROMAJI_SEASON_PATTERN.search(text)
        if match:
            return JimakuBridge.ROMAJI_SEASON_MAP[match.group(1).lower()]
        return None

    @staticmethod
    def _filename_has_japanese_text(value: str) -> bool:
        return bool(re.search('[\\u3040-\\u30ff\\u3400-\\u9fff]', str(value or '')))

    @staticmethod
    def _japanese_title_fragments(value: str) -> list[str]:
        return [part for part in re.findall('[\\u3040-\\u30ff\\u3400-\\u9fff]{2,}', str(value or '')) if len(part) >= 2]

    @staticmethod
    def _title_match_tokens(value: str) -> set[str]:
        text = str(value or '')
        text = re.sub('\\.[a-z0-9]{2,4}$', ' ', text, flags=re.IGNORECASE)
        text = re.sub('\\[[^\\]]*\\]', ' ', text)
        text = re.sub('\\([^)]*\\)', ' ', text)
        text = re.sub('\\bS\\d{1,2}E\\d{1,4}\\b', ' ', text, flags=re.IGNORECASE)
        text = re.sub('\\bS\\d{1,2}\\s*[-_.]\\s*\\d{1,4}\\b', ' ', text, flags=re.IGNORECASE)
        text = re.sub('\\bSeason\\s*\\d{1,2}\\s*[-_.]\\s*\\d{1,4}\\b', ' ', text, flags=re.IGNORECASE)
        text = re.sub('\\b\\d{1,2}x\\d{1,4}\\b', ' ', text, flags=re.IGNORECASE)
        text = re.sub('\\b(?:ep|episode|e)\\s*\\d{1,4}\\b', ' ', text, flags=re.IGNORECASE)
        text = re.sub('[-._]\\s*\\d{1,4}(?=\\s*(?:[._\\-\\[\\(]|$))', ' ', text, flags=re.IGNORECASE)
        text = text.replace('’', "'").replace('`', "'")
        text = re.sub('\\b(?:anime|watch|online|free|stream|streaming|season|sub|subs|subtitle|dub|webrip|web|bluray|blu|ray|bdrip|hdtv|atx|at-x|tv|aac|ac3|eac3|flac|hevc|h264|h265|x264|x265|av1|mpeg|mpeg2|opus|vobsub|sdh|cc|ja|jp|eng|1080p|720p|480p|2160p|1440p|10bit|8bit)\\b', ' ', text, flags=re.IGNORECASE)
        ignored = {'the', 'and', 'for', 'with', 'that', 'this', 'into', 'from', 'got'}
        tokens = {token for token in re.findall('[a-z0-9]+', text.lower()) if len(token) >= 3 and (not token.isdigit()) and (token not in ignored)}
        return tokens

    @classmethod
    def _subtitle_filename_matches_titles(cls, filename: str, allowed_titles: list[Any]) -> bool:
        allowed_japanese: list[str] = []
        allowed_tokens: set[str] = set()
        for value in allowed_titles:
            allowed_japanese.extend(cls._japanese_title_fragments(str(value or '')))
            allowed_tokens.update(cls._title_match_tokens(str(value or '')))
        file_japanese = cls._japanese_title_fragments(filename)
        if file_japanese and allowed_japanese:
            if any((a in f or f in a for f in file_japanese for a in allowed_japanese)):
                return True
            return False
        file_tokens = cls._title_match_tokens(filename)
        if len(file_tokens) >= 2 and allowed_tokens:
            return bool(file_tokens & allowed_tokens)
        return True

    def _download_srt(self, url: str) -> bytes:
        resp = self._session.get(url, timeout=15)
        resp.raise_for_status()
        content = resp.content
        if len(content) < 10:
            raise ValueError('srt content is too small')
        return content

    def _update_proxy(self, filename: str, srt_bytes: bytes, title: str='', episode: int | None=None) -> None:
        url = f'{self.proxy_base_url}/set-subtitle'
        body = {'subtitle_url': f'{self.proxy_base_url}/proxy-subtitle-srt', 'srt_content': srt_bytes.decode('utf-8', errors='replace'), 'filename': filename or 'subtitle.srt', 'title': title, 'episode': episode}
        try:
            resp = self._session.post(url, json=body, timeout=5)
            if resp.status_code >= 400:
                try:
                    err_body = resp.text[:300]
                except Exception:
                    err_body = '(unreadable)'
                LOGGER.warning('[JIMAKU] proxy update failed | status=%s | url=%s | body=%s', resp.status_code, url, err_body)
                return
            LOGGER.info('[JIMAKU] subtitle sent | filename=%s', body['filename'])
        except Exception as exc:
            LOGGER.error('[JIMAKU] update proxy error: %s', exc)