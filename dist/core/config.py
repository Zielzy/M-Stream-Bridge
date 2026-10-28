# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     3.1.0
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
from __future__ import annotations
import json
import os
from pathlib import Path
import sys
from typing import Any
CONFIG_FILENAME: str = 'config.json'

def _runtime_dir() -> Path:
    is_nuitka = False
    try:
        _ = __compiled__
        is_nuitka = True
    except NameError:
        pass
    if getattr(sys, 'frozen', False) or is_nuitka or sys.argv[0].lower().endswith('.exe'):
        if is_nuitka:
            try:
                return Path(__compiled__.containing_dir).resolve()
            except Exception:
                pass
        return Path(sys.argv[0]).resolve().parent
    candidates = [Path(__file__).resolve().parent.parent, Path.cwd()]
    for candidate in candidates:
        if (candidate / 'dashboard.html').exists():
            return candidate
    return candidates[0]

def get_config_path() -> Path:
    local_appdata = os.environ.get('LOCALAPPDATA')
    if local_appdata:
        old_config_dir = Path(local_appdata) / 'MigakuStreamBridge'
        new_config_dir = Path(local_appdata) / 'M-Stream Bridge'
        if old_config_dir.exists() and (not new_config_dir.exists()):
            try:
                old_config_dir.rename(new_config_dir)
            except Exception:
                pass
        config_dir = new_config_dir
    else:
        config_dir = _runtime_dir()
    try:
        config_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    old_file = config_dir / 'settings.json'
    new_file = config_dir / CONFIG_FILENAME
    if old_file.exists() and (not new_file.exists()):
        try:
            old_file.rename(new_file)
        except Exception:
            pass
    return new_file

def _load_config_dict() -> dict[str, Any]:
    config_path = get_config_path()
    if not config_path.exists():
        return {}
    try:
        payload = json.loads(config_path.read_text(encoding='utf-8'))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}

def load_jimaku_api_key() -> str:
    env_key = str(os.environ.get('JIMAKU_API_KEY') or '').strip()
    if env_key:
        return env_key
    payload = _load_config_dict()
    return str(payload.get('jimaku_api_key') or payload.get('api_key') or '').strip()

def load_subdl_api_key() -> str:
    payload = _load_config_dict()
    return str(payload.get('subdl_api_key') or '').strip()

def load_subdl_languages() -> str:
    payload = _load_config_dict()
    return str(payload.get('subdl_languages') or 'ID').strip()

def _load_dotenv() -> None:
    candidates = [_runtime_dir() / '.env', _runtime_dir().parent / '.env', Path.cwd() / '.env']
    if hasattr(sys, '_MEIPASS'):
        candidates.insert(0, Path(sys._MEIPASS) / '.env')
    for env_file in candidates:
        if env_file.exists():
            try:
                for line in env_file.read_text(encoding='utf-8').splitlines():
                    line = line.strip()
                    if line and (not line.startswith('#')) and ('=' in line):
                        k, v = line.split('=', 1)
                        os.environ.setdefault(k.strip(), v.strip().strip('\'"'))
            except Exception:
                pass
            break

def load_tmdb_api_key() -> str:
    _load_dotenv()
    env_key = str(os.environ.get('TMDB_API_KEY') or '').strip()
    if env_key:
        return env_key
    payload = _load_config_dict()
    return str(payload.get('tmdb_api_key') or '').strip()
DEFAULT_TMDB_GATEWAY_URL: str = 'https://m-stream-tmdb.zielzy.my.id/3'
TMDB_OFFICIAL_API_BASE: str = 'https://api.themoviedb.org/3'

def get_tmdb_endpoint(endpoint_path: str) -> tuple[str, dict[str, str]]:
    clean_path = endpoint_path.strip('/')
    if clean_path.startswith('3/'):
        clean_path = clean_path[2:]
    user_key = load_tmdb_api_key()
    if user_key:
        return (f'{TMDB_OFFICIAL_API_BASE}/{clean_path}', {'api_key': user_key})
    gateway_base = (os.environ.get('TMDB_GATEWAY_URL') or DEFAULT_TMDB_GATEWAY_URL).rstrip('/')
    if not gateway_base.endswith('/3'):
        gateway_base = f'{gateway_base}/3'
    return (f'{gateway_base}/{clean_path}', {})

def ensure_config_exists() -> None:
    config_path = get_config_path()
    payload = {}
    if config_path.exists():
        try:
            payload = json.loads(config_path.read_text(encoding='utf-8'))
        except Exception:
            payload = {}
    if not isinstance(payload, dict):
        payload = {}
    if not config_path.exists():
        try:
            config_path.write_text('{\n}', encoding='utf-8')
        except Exception:
            pass