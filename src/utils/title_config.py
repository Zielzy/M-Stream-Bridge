# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     __VERSION__
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
"""
Centralized Configuration Tuning for the V2 Evidence Resolution Engine.
"""

from __future__ import annotations

SOURCE_WEIGHTS: dict[str, float] = {
    "title_tag": 50.0,
    "url_slug": 40.0,
    "json_ld": 30.0,
    "og_title": 25.0,
    "twitter_title": 25.0,
    "heading": 15.0,
    "unknown": 0.0,
}

CLUSTER_THRESHOLD: float = 0.5

STOP_WORDS: set[str] = {
    "watch",
    "free",
    "online",
    "in",
    "hd",
    "english",
    "sub",
    "subtitle",
    "dub",
    "video",
    "movie",
    "show",
    "episode",
    "season",
    "on",
    "netflix",
    "hulu",
    "prime",
    "disney",
    "plex",
    "apple",
    "tv",
}

TOKEN_IGNORE: set[str] = {
    ".",
    ",",
    "!",
    "?",
    "-",
    "_",
    ":",
    ";",
    "(",
    ")",
    "[",
    "]",
    "{",
    "}",
    "/",
    "\\",
    "|",
    "&",
    "*",
    "#",
    "@",
    "+",
    "=",
    '"',
    "'",
    "`",
    "•",
    "·",
    "—",
    "–",
}

