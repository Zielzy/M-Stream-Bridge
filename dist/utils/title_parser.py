# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     3.1.0
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
from __future__ import annotations
from functools import lru_cache
import logging
import re
LOGGER = logging.getLogger('mstream_bridge')
UI_NOISE_PENALTY: int = 200
SITE_NAME_PENALTY: int = 200
URL_PENALTY: int = 300
NOISE_PENALTY: int = 50
PREFIX_NOISE: list[str] = ['watch', 'nonton', 'streaming?', 'cast\\s+of']
SUFFIX_NOISE: list[str] = ['watch\\s+online\\s+free', 'watch\\s+online', 'watch\\s+free', 'watch', 'streaming?', 'nonton', 'full\\s+movies?', 'full\\s+episodes?', 'free', 'online', 'in\\s+hd', 'hd', 'eng(?:lish)?\\s*(?:sub(?:title)?|dub)?', 'jpn\\s*(?:sub(?:title)?|dub)?', 'jap(?:anese)?\\s*(?:sub(?:title)?|dub)?', 'indo(?:nesia)?\\s*(?:sub(?:title)?|dub)?', 'sub(?:title)?|dub', 'english', 'videos?', 'movies?', 'shows?', 'ratings?\\s*(?:&|and)?\\s*reviews?', 'trivia', 'episode\\s+terbaru', 'on\\s+plex', 'on\\s+netflix', 'on\\s+prime\\s+video', 'on\\s+hulu', 'on\\s+disney\\+?', 'on\\s+apple\\s+tv']
SCENE_TAGS: list[str] = ['1080p', '720p', '480p', '2160p', '4k', '8k', 'bluray', 'brrip', 'bdrip', 'web-?dl', 'webrip', 'hdtv', 'hdrip', 'x264', 'x265', 'hevc', 'aac', 'ac3', 'dts', 'yify', 'yts', 'mp4', 'mkv', 'avi']
PREFIX_NOISE_RE: re.Pattern[str] = re.compile('^(?:' + '|'.join(PREFIX_NOISE) + ')\\b', re.IGNORECASE)
SUFFIX_NOISE_RE: re.Pattern[str] = re.compile('\\b(?:' + '|'.join(SUFFIX_NOISE) + ')$', re.IGNORECASE)
SCENE_TAGS_RE: re.Pattern[str] = re.compile('\\b(?:' + '|'.join(SCENE_TAGS) + ')\\b', re.IGNORECASE)
EP_SEASON_RE: re.Pattern[str] = re.compile('\\b(?:s\\d{1,2}e\\d{1,4}|\\d{1,2}x\\d{1,4}|episode\\s*\\d+|ep\\.?\\s*\\d+|season\\s*\\d+|s\\d{1,2}|part\\s*\\d+|cour\\s*\\d+)\\b', re.IGNORECASE)
SITES_RE: re.Pattern[str] = re.compile('\\b(?:miruro|animekai|otakudesu|gogoanime|aniwave|zoro(?:to)?|9anime|crunchyroll|funimation|kissanime|kissasian|dramacool|asianwiki|mydramalist|newdramaplay|animesuge|animixplay|animedao|aniwatch|kaido(?:to)?|hianime|yugenanime|animefox|animepahe|bilibili|anidap|idlix|netflix|amazon|disney|hulu|loklok|bflix|fbox|movies2watch|fmovies|rive|rivestream|animex|anikoto)\\b', re.IGNORECASE)
UI_NOISE_RE: re.Pattern[str] = re.compile('^(?:continue\\s+watching|up\\s+next|next\\s+up|resume|play\\s+next|keep\\s+watching|because\\s+you\\s+watched|recommended(?:\\s+for\\s+you)?|top\\s+picks|top\\s+10|latest|recently\\s+(?:added|released)|favourit?es|library|dashboard|discover|live\\s+tv|downloads|search|settings|home|movies?|series|browse|collections?|my\\s+media|okay-ish\\s+anime\\s+website|anime\\s+community\\s+embed|embed\\s+widget|just\\s+a\\s+moment(?:\\.\\.\\.)?|checking\\s+your\\s+browser.*|movies?\\s*/\\s*tv\\s*/\\s*anime|freemediaheckyeah|video\\s+player|get\\s+\\w+\\s+on\\s+your\\s+devices?|comments?|discussions?)$', re.IGNORECASE)
URL_RE: re.Pattern[str] = re.compile('(?:https?://|www\\.)|\\.(?:mp4|m3u8|mkv|webm|ts)\\b', re.IGNORECASE)

@lru_cache(maxsize=512)
def score_title(title: str) -> float:
    t = (title or '').strip()
    if not t:
        return -9999.0
    score = 0.0
    is_ui_noise = False
    if UI_NOISE_RE.match(t):
        is_ui_noise = True
    else:
        cleaned_for_noise = EP_SEASON_RE.sub('', t).strip()
        cleaned_for_noise = re.sub('\\s*(?:[-|:]\\s*)?(?:season|s\\d|part|cour).*$', '', cleaned_for_noise, flags=re.IGNORECASE).strip()
        cleaned_for_noise = re.sub('\\s+', ' ', cleaned_for_noise).strip()
        if UI_NOISE_RE.match(cleaned_for_noise):
            is_ui_noise = True
    if not is_ui_noise and (not URL_RE.search(t)):
        score += 40
    if re.search('\\b(?:19|20)\\d{2}\\b', t):
        score += 15
    if EP_SEASON_RE.search(t):
        score += 10
    word_count = len(t.split())
    if word_count >= 3:
        score += 25
    elif word_count == 2:
        score += 10
    elif word_count == 1:
        score -= 20
    if SCENE_TAGS_RE.search(t):
        score -= 10
    if 3 <= len(t) <= 150:
        score += 10
    if t.isdigit():
        score -= 50
    if is_ui_noise:
        score -= float(UI_NOISE_PENALTY)
    if URL_RE.search(t):
        score -= URL_PENALTY
    if SITES_RE.search(t):
        score -= SITE_NAME_PENALTY
    if PREFIX_NOISE_RE.search(t) or SUFFIX_NOISE_RE.search(t):
        noise_stripped = SUFFIX_NOISE_RE.sub('', PREFIX_NOISE_RE.sub('', t)).strip()
        if len(noise_stripped) < 3:
            score -= NOISE_PENALTY
        else:
            score -= 5
    return score

def clean_media_title(raw: str) -> str:
    t = (raw or '').strip()
    if not t:
        return ''
    t = re.sub('[▶►\\u25B6\\u25BA]+', '', t).strip()
    t = re.sub('\\s*\\((?:19|20)\\d{2}\\)', '', t).strip()
    if ' ' not in t and '.' in t and SCENE_TAGS_RE.search(t):
        t = t.replace('.', ' ')
    t = re.sub('[?#].*$', '', t)
    segments = [s.strip() for s in re.split('[|\\u2014\\u2013\\u00B7\\u2022~–]+|::', t) if s.strip()]
    if len(segments) <= 1:
        segments = [s.strip() for s in re.split('\\s+-\\s+', t) if s.strip()]
    if not segments:
        return ''
    while len(segments) > 1 and SITES_RE.search(segments[-1]):
        segments.pop()
    while len(segments) > 1 and SITES_RE.search(segments[0]):
        segments.pop(0)
    best_segment = ''
    best_score = -99999.0
    debug_scores: list[str] = []
    for i, seg in enumerate(segments):
        score = score_title(seg)
        if len(seg) <= 4 and (i == 0 or i == len(segments) - 1):
            score -= 50
        debug_scores.append(f'{seg!r}({score})')
        if score > best_score:
            best_score = score
            best_segment = seg
    final_title = best_segment if best_score > 0 else segments[0] if segments else t
    changed = True
    while changed:
        old_title = final_title
        final_title = PREFIX_NOISE_RE.sub('', final_title).strip()
        final_title = SUFFIX_NOISE_RE.sub('', final_title).strip()
        final_title = EP_SEASON_RE.sub('', final_title).strip()
        final_title = SCENE_TAGS_RE.sub('', final_title).strip()
        final_title = re.sub('^anime\\s+', '', final_title, flags=re.IGNORECASE).strip()
        final_title = re.sub('\\banime\\b\\s*$', '', final_title, flags=re.IGNORECASE).strip()
        final_title = re.sub('\\[\\s*\\]|\\(\\s*\\)', '', final_title).strip()
        final_title = re.sub('\\s*(?:[-|:]\\s*)?(?:season|s\\d|part|cour).*$', '', final_title, flags=re.IGNORECASE).strip()
        changed = old_title != final_title
    final_title = re.sub('[-_]+', ' ', final_title)
    final_title = re.sub('\\s+', ' ', final_title).strip()
    result = final_title if final_title else (raw or '').strip()
    LOGGER.debug('[PARSER] clean_media_title | raw=%r | segments=[%s] | winning_segment=%r | final_cleaned=%r', raw, ', '.join(debug_scores), best_segment, result)
    return result