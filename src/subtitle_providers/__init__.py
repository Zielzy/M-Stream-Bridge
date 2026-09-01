"""
Subtitle Providers Package for M-Stream Bridge.
"""

from __future__ import annotations

from subtitle_providers.jimaku import JimakuBridge, _is_subtitle_like_url, _stream_key
from subtitle_providers.subdl import SubdlProvider

__all__ = [
    "JimakuBridge",
    "SubdlProvider",
    "_is_subtitle_like_url",
    "_stream_key",
]
