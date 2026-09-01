# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     __VERSION__
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
"""
Configuration loaders, environment variable parsers, and runtime directory resolvers.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
from typing import Any

CONFIG_FILENAME: str = "config.json"


# =============================================================================
# Path & Directory Resolvers
# =============================================================================

def _runtime_dir() -> Path:
    """Return the folder where user-editable release assets live."""
    is_nuitka = False
    try:
        _ = __compiled__  # type: ignore[name-defined]
        is_nuitka = True
    except NameError:
        pass

    if getattr(sys, "frozen", False) or is_nuitka or sys.argv[0].lower().endswith(".exe"):
        if is_nuitka:
            try:
                return Path(__compiled__.containing_dir).resolve()  # type: ignore[name-defined]
            except Exception:
                pass
        return Path(sys.argv[0]).resolve().parent

    candidates = [Path(__file__).resolve().parent.parent, Path.cwd()]
    for candidate in candidates:
        if (candidate / "dashboard.html").exists():
            return candidate
    return candidates[0]


def get_config_path() -> Path:
    """Return the full filesystem path to the user's config.json file."""
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        old_config_dir = Path(local_appdata) / "MigakuStreamBridge"
        new_config_dir = Path(local_appdata) / "M-Stream Bridge"
        if old_config_dir.exists() and not new_config_dir.exists():
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

    old_file = config_dir / "settings.json"
    new_file = config_dir / CONFIG_FILENAME
    if old_file.exists() and not new_file.exists():
        try:
            old_file.rename(new_file)
        except Exception:
            pass

    return new_file


def _load_config_dict() -> dict[str, Any]:
    """Read and parse config.json, returning an empty dict on missing file or parse failure."""
    config_path = get_config_path()
    if not config_path.exists():
        return {}
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


# =============================================================================
# API Key & Preference Loaders
# =============================================================================

def load_jimaku_api_key() -> str:
    """Retrieve Jimaku API key from environment variable or config.json."""
    env_key = str(os.environ.get("JIMAKU_API_KEY") or "").strip()
    if env_key:
        return env_key
    payload = _load_config_dict()
    return str(payload.get("jimaku_api_key") or payload.get("api_key") or "").strip()


def load_subdl_api_key() -> str:
    """Retrieve SubDL API key from config.json."""
    payload = _load_config_dict()
    return str(payload.get("subdl_api_key") or "").strip()


def load_subdl_languages() -> str:
    """Retrieve SubDL target language codes from config.json, defaulting to 'ID'."""
    payload = _load_config_dict()
    return str(payload.get("subdl_languages") or "ID").strip()


def _load_dotenv() -> None:
    """Load key-value pairs from .env files into os.environ if present."""
    candidates = [
        _runtime_dir() / ".env",
        _runtime_dir().parent / ".env",
        Path.cwd() / ".env",
    ]
    if hasattr(sys, "_MEIPASS"):
        candidates.insert(0, Path(sys._MEIPASS) / ".env")  # type: ignore[attr-defined]

    for env_file in candidates:
        if env_file.exists():
            try:
                for line in env_file.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        os.environ.setdefault(k.strip(), v.strip().strip("'\""))
            except Exception:
                pass
            break


def load_tmdb_api_key() -> str:
    """Retrieve TMDB API key from environment (.env) or config.json."""
    _load_dotenv()
    env_key = str(os.environ.get("TMDB_API_KEY") or "").strip()
    if env_key:
        return env_key
    payload = _load_config_dict()
    return str(payload.get("tmdb_api_key") or "").strip()


def ensure_config_exists() -> None:
    """Ensure the user configuration file exists on disk, initializing with empty JSON if absent."""
    config_path = get_config_path()
    payload = {}
    if config_path.exists():
        try:
            payload = json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            payload = {}

    if not isinstance(payload, dict):
        payload = {}
    if not config_path.exists():
        try:
            config_path.write_text("{\n}", encoding="utf-8")
        except Exception:
            pass

