# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     __VERSION__
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
"""
Media Title Parser and Segment Scoring Engine for M-Stream Bridge.
"""

from __future__ import annotations

from functools import lru_cache
import logging
import re

LOGGER = logging.getLogger("mstream_bridge")

# =============================================================================
# Penalty Weights & Noise Dictionaries
# =============================================================================

UI_NOISE_PENALTY: int = 200
SITE_NAME_PENALTY: int = 200
URL_PENALTY: int = 300
NOISE_PENALTY: int = 50

PREFIX_NOISE: list[str] = [
    r"watch",
    r"nonton",
    r"streaming?",
    r"cast\s+of",
]

SUFFIX_NOISE: list[str] = [
    r"watch\s+online\s+free",
    r"watch\s+online",
    r"watch\s+free",
    r"watch",
    r"streaming?",
    r"nonton",
    r"full\s+movies?",
    r"full\s+episodes?",
    r"free",
    r"online",
    r"in\s+hd",
    r"hd",
    r"eng(?:lish)?\s*(?:sub(?:title)?|dub)?",
    r"jpn\s*(?:sub(?:title)?|dub)?",
    r"jap(?:anese)?\s*(?:sub(?:title)?|dub)?",
    r"indo(?:nesia)?\s*(?:sub(?:title)?|dub)?",
    r"sub(?:title)?|dub",
    r"english",
    r"videos?",
    r"movies?",
    r"shows?",
    r"ratings?\s*(?:&|and)?\s*reviews?",
    r"trivia",
    r"episode\s+terbaru",
    r"on\s+plex",
    r"on\s+netflix",
    r"on\s+prime\s+video",
    r"on\s+hulu",
    r"on\s+disney\+?",
    r"on\s+apple\s+tv",
]

SCENE_TAGS: list[str] = [
    r"1080p", r"720p", r"480p", r"2160p", r"4k", r"8k",
    r"bluray", r"brrip", r"bdrip", r"web-?dl", r"webrip", r"hdtv", r"hdrip",
    r"x264", r"x265", r"hevc", r"aac", r"ac3", r"dts", r"yify", r"yts",
    r"mp4", r"mkv", r"avi",
]

PREFIX_NOISE_RE: re.Pattern[str] = re.compile(r"^(?:" + "|".join(PREFIX_NOISE) + r")\b", re.IGNORECASE)
SUFFIX_NOISE_RE: re.Pattern[str] = re.compile(r"\b(?:" + "|".join(SUFFIX_NOISE) + r")$", re.IGNORECASE)
SCENE_TAGS_RE: re.Pattern[str] = re.compile(r"\b(?:" + "|".join(SCENE_TAGS) + r")\b", re.IGNORECASE)

# Episode / Season markers regex
EP_SEASON_RE: re.Pattern[str] = re.compile(
    r"\b(?:s\d{1,2}e\d{1,4}|\d{1,2}x\d{1,4}|episode\s*\d+|ep\.?\s*\d+|season\s*\d+|s\d{1,2}|part\s*\d+|cour\s*\d+)\b",
    re.IGNORECASE,
)

# Known Site names regex
SITES_RE: re.Pattern[str] = re.compile(
    r"\b(?:miruro|animekai|otakudesu|gogoanime|aniwave|zoro(?:to)?"
    r"|9anime|crunchyroll|funimation|kissanime|kissasian|dramacool"
    r"|asianwiki|mydramalist|newdramaplay|animesuge|animixplay"
    r"|animedao|aniwatch|kaido(?:to)?|hianime|yugenanime|animefox"
    r"|animepahe|bilibili|anidap|idlix|netflix|amazon|disney|hulu"
    r"|loklok|bflix|fbox|movies2watch|fmovies|rive|rivestream|animex|anikoto)\b",
    re.IGNORECASE,
)

# Exact Match UI Noise
UI_NOISE_RE: re.Pattern[str] = re.compile(
    r"^(?:continue\s+watching|up\s+next|next\s+up|resume|play\s+next|keep\s+watching|because\s+you\s+watched|"
    r"recommended(?:\s+for\s+you)?|top\s+picks|top\s+10|latest|recently\s+(?:added|released)|favourit?es|"
    r"library|dashboard|discover|live\s+tv|downloads|search|settings|home|movies?|series|browse|collections?|my\s+media|"
    r"okay-ish\s+anime\s+website|anime\s+community\s+embed|embed\s+widget|just\s+a\s+moment(?:\.\.\.)?|"
    r"checking\s+your\s+browser.*|movies?\s*/\s*tv\s*/\s*anime|freemediaheckyeah|video\s+player|get\s+\w+\s+on\s+your\s+devices?)$",
    re.IGNORECASE,
)

# URL / Extension Noise
URL_RE: re.Pattern[str] = re.compile(r"(?:https?://|www\.)|\.(?:mp4|m3u8|mkv|webm|ts)\b", re.IGNORECASE)


# =============================================================================
# Scoring & Title Cleaning Functions
# =============================================================================

@lru_cache(maxsize=512)
def score_title(title: str) -> float:
    """Evaluate heuristic quality score for a title string or title segment."""
    t = (title or "").strip()
    if not t:
        return -9999.0

    score = 0.0

    is_ui_noise = False
    if UI_NOISE_RE.match(t):
        is_ui_noise = True
    else:
        # Clean episode/season markers to see if it reduces to UI noise
        cleaned_for_noise = EP_SEASON_RE.sub("", t).strip()
        cleaned_for_noise = re.sub(r"\s*(?:[-|:]\s*)?(?:season|s\d|part|cour).*$", "", cleaned_for_noise, flags=re.IGNORECASE).strip()
        cleaned_for_noise = re.sub(r"\s+", " ", cleaned_for_noise).strip()
        if UI_NOISE_RE.match(cleaned_for_noise):
            is_ui_noise = True

    # +40 if not UI noise or URL
    if not is_ui_noise and not URL_RE.search(t):
        score += 40

    # Heuristic Quality Signal (Finer-grained)
    if re.search(r"\b(?:19|20)\d{2}\b", t):
        score += 15

    if EP_SEASON_RE.search(t):
        score += 10

    # Favor multi-word story titles over 1-word site brand segments
    word_count = len(t.split())
    if word_count >= 3:
        score += 25
    elif word_count == 2:
        score += 10
    elif word_count == 1:
        score -= 20

    if SCENE_TAGS_RE.search(t):
        score -= 10

    # +10 if character length between 3 - 150
    if 3 <= len(t) <= 150:
        score += 10

    # -50 if digits only
    if t.isdigit():
        score -= 50

    # Penalties
    if is_ui_noise:
        score -= float(UI_NOISE_PENALTY)

    if URL_RE.search(t):
        score -= URL_PENALTY

    if SITES_RE.search(t):
        score -= SITE_NAME_PENALTY

    if PREFIX_NOISE_RE.search(t) or SUFFIX_NOISE_RE.search(t):
        noise_stripped = SUFFIX_NOISE_RE.sub("", PREFIX_NOISE_RE.sub("", t)).strip()
        if len(noise_stripped) < 3:
            score -= NOISE_PENALTY
        else:
            score -= 5

    return score


def clean_media_title(raw: str) -> str:
    """Clean raw title for client display using Segment Scoring."""
    t = (raw or "").strip()
    if not t:
        return ""

    # Remove play symbol or weird icons
    t = re.sub(r"[▶►\u25B6\u25BA]+", "", t).strip()

    # 1. Remove year in parentheses before scoring (e.g. Title (2024))
    t = re.sub(r"\s*\((?:19|20)\d{2}\)", "", t).strip()

    # 1.5. Convert scene release dot notation to spaces
    if " " not in t and "." in t and SCENE_TAGS_RE.search(t):
        t = t.replace(".", " ")

    # 2. Remove common noise before splitting (like leaked URL queries)
    t = re.sub(r"[?#].*$", "", t)

    # 3. Split string based on common delimiters (\u2022 is bullet point •)
    segments = [s.strip() for s in re.split(r"[|\u2014\u2013\u00B7\u2022~–]+|::", t) if s.strip()]

    # If splitting by delimiter fails (only 1 segment), try splitting by dash (-)
    if len(segments) <= 1:
        segments = [s.strip() for s in re.split(r"\s+-\s+", t) if s.strip()]

    if not segments:
        return ""

    while len(segments) > 1 and SITES_RE.search(segments[-1]):
        segments.pop()

    while len(segments) > 1 and SITES_RE.search(segments[0]):
        segments.pop(0)

    best_segment = ""
    best_score = -99999.0
    debug_scores: list[str] = []

    for i, seg in enumerate(segments):
        score = score_title(seg)

        # Penalize if it's very short and the first or last segment (likely a site name or prefix)
        if len(seg) <= 4 and (i == 0 or i == len(segments) - 1):
            score -= 50

        debug_scores.append(f"{seg!r}({score})")

        if score > best_score:
            best_score = score
            best_segment = seg

    final_title = best_segment if best_score > 0 else (segments[0] if segments else t)

    # Clean up any remaining noise/episode markers inside the winning segment
    changed = True
    while changed:
        old_title = final_title
        final_title = PREFIX_NOISE_RE.sub("", final_title).strip()
        final_title = SUFFIX_NOISE_RE.sub("", final_title).strip()
        final_title = EP_SEASON_RE.sub("", final_title).strip()
        final_title = SCENE_TAGS_RE.sub("", final_title).strip()
        final_title = re.sub(r"^anime\s+", "", final_title, flags=re.IGNORECASE).strip()
        final_title = re.sub(r"\banime\b\s*$", "", final_title, flags=re.IGNORECASE).strip()
        # Remove empty brackets that might remain, e.g., "Interstellar []" or "()"
        final_title = re.sub(r"\[\s*\]|\(\s*\)", "", final_title).strip()
        # Remove trailing season/part (e.g. "Season 2" at the end)
        final_title = re.sub(r"\s*(?:[-|:]\s*)?(?:season|s\d|part|cour).*$", "", final_title, flags=re.IGNORECASE).strip()
        changed = old_title != final_title

    # Replace dashes and underscores with spaces
    final_title = re.sub(r"[-_]+", " ", final_title)

    # Collapse whitespace
    final_title = re.sub(r"\s+", " ", final_title).strip()

    result = final_title if final_title else (raw or "").strip()

    LOGGER.debug(
        "[PARSER] clean_media_title | raw=%r | segments=[%s] | winning_segment=%r | final_cleaned=%r",
        raw, ", ".join(debug_scores), best_segment, result,
    )

    return result

