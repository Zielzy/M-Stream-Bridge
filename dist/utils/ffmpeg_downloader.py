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
from pathlib import Path
import shutil
import threading
import urllib.request
import zipfile
try:
    import certifi
    if 'SSL_CERT_FILE' not in os.environ:
        os.environ['SSL_CERT_FILE'] = certifi.where()
except Exception:
    pass
from core.config import get_config_path
logger = logging.getLogger('mstream_bridge')
FFMPEG_URL: str = 'https://github.com/GyanD/codexffmpeg/releases/download/7.0.1/ffmpeg-7.0.1-essentials_build.zip'
_download_thread: threading.Thread | None = None
_download_status: str = 'idle'
_last_print_percent: int = -1

def get_ffmpeg_path() -> Path:
    sys_ffmpeg = shutil.which('ffmpeg')
    if sys_ffmpeg:
        return Path(sys_ffmpeg)
    binary_name = 'ffmpeg.exe' if os.name == 'nt' else 'ffmpeg'
    return get_config_path().parent / 'bin' / binary_name

def is_ffmpeg_installed() -> bool:
    return shutil.which('ffmpeg') is not None or get_ffmpeg_path().exists()

def download_ffmpeg_async() -> None:
    global _download_thread, _download_status, _last_print_percent
    if is_ffmpeg_installed():
        _download_status = 'done'
        return
    if os.name != 'nt':
        logger.info("[FFMPEG] Please install ffmpeg via your package manager (e.g., 'brew install ffmpeg' on macOS or 'sudo apt install ffmpeg' on Linux)")
        _download_status = 'idle'
        return
    if _download_thread and _download_thread.is_alive():
        return
    _download_status = 'downloading'
    _last_print_percent = -1
    _download_thread = threading.Thread(target=_download_and_extract_ffmpeg, daemon=True, name='FFmpegDownloader')
    _download_thread.start()

def _download_progress(count: int, block_size: int, total_size: int) -> None:
    global _last_print_percent
    if total_size > 0:
        percent = int(count * block_size * 100 / total_size)
        if percent > 100:
            percent = 100
        if percent % 10 == 0 and percent != _last_print_percent:
            logger.info(f'[FFMPEG] Downloading... {percent}%')
            _last_print_percent = percent

def _download_and_extract_ffmpeg() -> None:
    global _download_status
    try:
        bin_dir = get_config_path().parent / 'bin'
        bin_dir.mkdir(parents=True, exist_ok=True)
        zip_path = bin_dir / 'ffmpeg.zip'
        logger.info(f'[FFMPEG] Downloading FFmpeg from {FFMPEG_URL}...')
        urllib.request.urlretrieve(FFMPEG_URL, zip_path, reporthook=_download_progress)
        logger.info('[FFMPEG] Extracting FFmpeg...')
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            for info in zip_ref.infolist():
                if info.filename.endswith('ffmpeg.exe'):
                    with zip_ref.open(info) as source:
                        target_path = get_ffmpeg_path()
                        with open(target_path, 'wb') as target:
                            target.write(source.read())
                    break
        logger.info('[FFMPEG] Cleaning up zip...')
        if zip_path.exists():
            os.remove(zip_path)
        _download_status = 'done'
        logger.info(f'[FFMPEG] FFmpeg installed successfully at {get_ffmpeg_path()}')
    except Exception as e:
        logger.error(f'[FFMPEG] Error downloading FFmpeg: {e}')
        _download_status = 'error'

def get_download_status() -> str:
    if is_ffmpeg_installed():
        return 'done'
    return _download_status