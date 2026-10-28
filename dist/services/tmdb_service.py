# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     3.1.0
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
from __future__ import annotations
import urllib.parse
from collections.abc import Callable
import queue
import threading
from typing import Any
import requests
from core.config import load_tmdb_api_key, get_tmdb_endpoint
from utils.tmdb_search import generate_tmdb_queries, tmdb_search

class TMDBService:
    _instance: TMDBService | None = None

    @classmethod
    def get_instance(cls, logger_func: Callable[[str, str], None] | None=None) -> TMDBService:
        if cls._instance is None:
            cls._instance = cls(logger_func)
        return cls._instance

    def __init__(self, logger_func: Callable[[str, str], None] | None=None) -> None:
        self.logger: Callable[[str, str], None] | None = logger_func
        self.api_key: str | None = load_tmdb_api_key()
        self.cache: dict[str, dict[str, Any]] = {}
        self.max_cache: int = 500
        self.queue: queue.Queue[tuple[dict[str, Any], str, str]] = queue.Queue()
        self.latest_tasks: dict[str, str] = {}
        threading.Thread(target=self._worker_loop, daemon=True, name='TMDBWorker').start()

    def _log(self, level: str, msg: str) -> None:
        if self.logger:
            self.logger(level, msg)
        else:
            print(f'[{level}] {msg}')

    def request_artwork(self, stream_obj: dict[str, Any]) -> None:
        title = stream_obj.get('display_title')
        stream_id = str(stream_obj.get('id') or 'current_stream')
        if not title:
            return
        self.latest_tasks[stream_id] = title
        self.queue.put((stream_obj, title, stream_id))

    def _worker_loop(self) -> None:
        session = requests.Session()
        while True:
            task = self.queue.get()
            if not task:
                continue
            try:
                stream_obj, title, stream_id = task
                if self.latest_tasks.get(stream_id) != title:
                    continue
                if stream_obj.get('display_title') != title:
                    continue
                if title in self.cache:
                    stream_obj['tmdb'] = self.cache[title]
                    continue
                queries = generate_tmdb_queries(title)
                data = tmdb_search(session, self.api_key, queries)
                best_item = next((item for item in data if item.get('poster_path') and item.get('backdrop_path')), None)
                if not best_item:
                    best_item = next((item for item in data if item.get('poster_path')), None)
                tmdb_data: dict[str, Any] = {'poster': None, 'backdrop': None, 'media_type': None, 'id': None}
                if best_item:
                    tmdb_data['poster'] = best_item.get('poster_path')
                    tmdb_data['backdrop'] = best_item.get('backdrop_path') or best_item.get('poster_path')
                    tmdb_data['media_type'] = best_item.get('media_type')
                    tmdb_data['id'] = best_item.get('id')
                    gw_url, _ = get_tmdb_endpoint('')
                    gw_host = urllib.parse.urlparse(gw_url).netloc or 'm-stream-tmdb.zielzy.my.id'
                    self._log('INFO', f"[TMDB] Artwork resolved via https://{gw_host} for {title!r} -> id={best_item.get('id')}")
                else:
                    self._log('DEBUG', f'[TMDB] No artwork found for {title!r}')
                if len(self.cache) >= self.max_cache:
                    del self.cache[next(iter(self.cache))]
                self.cache[title] = tmdb_data
                if stream_obj.get('display_title') == title:
                    stream_obj['tmdb'] = tmdb_data
            except Exception as e:
                self._log('ERROR', f'[TMDBService] Worker failed: {e}')
            finally:
                self.queue.task_done()