# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     3.1.0
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
from __future__ import annotations
from dataclasses import dataclass, field
import html
import re
from typing import Any
from utils import title_config
from utils.title_parser import score_title

@dataclass
class Cluster:
    normalized_title: str
    tokens: set[str] = field(default_factory=set)
    evidences: list[dict[str, Any]] = field(default_factory=list)
    unique_sources: list[str] = field(default_factory=list)
    heuristic_score: float = 0.0
    source_bonus: float = 0.0
    total_score: float = 0.0

@dataclass
class ResolvedEvidence:
    title: str
    normalized_title: str
    winning_cluster: Cluster
    all_clusters: list[Cluster] = field(default_factory=list)
    title_sources: list[str] = field(default_factory=list)
    score: dict[str, float] = field(default_factory=dict)
    evidence_count: int = 0
EP_SEASON_RE: re.Pattern[str] = re.compile('\\b(?:s\\d{1,2}e\\d{1,4}|\\d{1,2}x\\d{1,4}|episode\\s*\\d+|ep\\.?\\s*\\d+|season\\s*\\d+|s\\d{1,2}|part\\s*\\d+|cour\\s*\\d+)\\b', re.IGNORECASE)

def extract_season_episode_context(title: str) -> dict[str, set[int]]:
    seasons: set[int] = set()
    episodes: set[int] = set()
    t = title.lower().replace('-', ' ').replace('_', ' ')
    for match in re.findall('\\bs(\\d{1,2})e(\\d{1,4})\\b', t):
        seasons.add(int(match[0]))
        episodes.add(int(match[1]))
    for match in re.findall('\\b(\\d{1,2})x(\\d{1,4})\\b', t):
        seasons.add(int(match[0]))
        episodes.add(int(match[1]))
    for match in re.findall('\\bseason\\s*(\\d+)\\b', t):
        seasons.add(int(match))
    for match in re.findall('\\bs(\\d{1,2})\\b(?!e\\d)', t):
        seasons.add(int(match))
    for match in re.findall('\\bepisode\\s*(\\d+)\\b', t):
        episodes.add(int(match))
    for match in re.findall('\\bep\\.?\\s*(\\d+)\\b', t):
        episodes.add(int(match))
    for match in re.findall('\\be(\\d{1,4})\\b', t):
        episodes.add(int(match))
    for match in re.findall('\\bpart\\s*(\\d+)\\b', t):
        episodes.add(int(match))
    for match in re.findall('\\bcour\\s*(\\d+)\\b', t):
        episodes.add(int(match))
    return {'seasons': seasons, 'episodes': episodes}

def has_context_conflict(context_a: dict[str, set[int]], context_b: dict[str, set[int]]) -> bool:
    for key in ['seasons', 'episodes']:
        set_a = context_a[key]
        set_b = context_b[key]
        if set_a and set_b:
            if not set_a & set_b:
                return True
    return False

def get_tokens(title: str) -> set[str]:
    t = title.lower().replace('-', ' ').replace('_', ' ').strip()
    context = extract_season_episode_context(t)
    context_tokens: set[str] = set()
    for s in context['seasons']:
        context_tokens.add(f'season{s}')
    for e in context['episodes']:
        context_tokens.add(f'episode{e}')
    t = EP_SEASON_RE.sub(' ', t)
    for char in title_config.TOKEN_IGNORE:
        t = t.replace(char, ' ')
    raw_tokens = t.split()
    tokens: set[str] = set()
    for tok in raw_tokens:
        tok = tok.strip()
        if not tok:
            continue
        if tok in title_config.STOP_WORDS:
            continue
        tokens.add(tok)
    tokens.update(context_tokens)
    return tokens

def light_normalize(title: str) -> str:
    t = title.lower().strip()
    for char in title_config.TOKEN_IGNORE:
        t = t.replace(char, ' ')
    return ' '.join(t.split())

def token_similarity(tokens_a: set[str], tokens_b: set[str]) -> float:
    if not tokens_a and (not tokens_b):
        return 1.0
    if not tokens_a or not tokens_b:
        return 0.0
    intersection = tokens_a & tokens_b
    if not intersection:
        return 0.0
    if len(intersection) == 1 and (len(tokens_a) > 1 or len(tokens_b) > 1):
        return len(intersection) / len(tokens_a | tokens_b)
    jaccard = len(intersection) / len(tokens_a | tokens_b)
    overlap = len(intersection) / min(len(tokens_a), len(tokens_b))
    return max(jaccard, overlap)

def normalize(evidence_list: list[Any]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    if not evidence_list:
        return normalized
    for item in evidence_list:
        if item is None:
            continue
        if isinstance(item, str):
            val = html.unescape(item.strip())
            if val:
                normalized.append({'value': val, 'source': 'unknown'})
        elif isinstance(item, dict):
            val = item.get('value') or item.get('title')
            if val is not None:
                val = html.unescape(str(val).strip())
                if val:
                    src = item.get('source') or 'unknown'
                    normalized.append({'value': val, 'source': str(src).strip()})
        else:
            val = html.unescape(str(item).strip())
            if val:
                normalized.append({'value': val, 'source': 'unknown'})
    return normalized

def deduplicate(evidences: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str]] = set()
    deduped: list[dict[str, Any]] = []
    for ev in evidences:
        key = (ev['value'], ev['source'])
        if key not in seen:
            seen.add(key)
            deduped.append(ev)
    return deduped

def cluster(evidences: list[dict[str, Any]]) -> list[Cluster]:
    clusters: list[Cluster] = []
    for ev in evidences:
        val = ev['value']
        tokens = get_tokens(val)
        context = extract_season_episode_context(val)
        best_match_cluster: Cluster | None = None
        best_similarity: float = -1.0
        for c in clusters:
            sim = token_similarity(tokens, c.tokens)
            has_conflict = False
            for c_ev in c.evidences:
                c_context = extract_season_episode_context(c_ev['value'])
                if has_context_conflict(context, c_context):
                    has_conflict = True
                    break
            if not has_conflict and sim >= title_config.CLUSTER_THRESHOLD:
                if sim > best_similarity:
                    best_similarity = sim
                    best_match_cluster = c
        if best_match_cluster is not None:
            best_match_cluster.evidences.append(ev)
            if ev['source'] not in best_match_cluster.unique_sources:
                best_match_cluster.unique_sources.append(ev['source'])
        else:
            new_c = Cluster(normalized_title=light_normalize(val), tokens=set(tokens), evidences=[ev], unique_sources=[ev['source']], heuristic_score=0.0, source_bonus=0.0, total_score=0.0)
            clusters.append(new_c)
    return clusters

def score(clusters: list[Cluster]) -> list[Cluster]:
    for c in clusters:
        max_h_score = -99999.0
        for ev in c.evidences:
            s = float(score_title(ev['value']))
            if s > max_h_score:
                max_h_score = s
        c.heuristic_score = max_h_score
        bonus = 0.0
        for src in c.unique_sources:
            b = title_config.SOURCE_WEIGHTS.get(src, 0.0)
            if src in ('title_tag', 'page_meta_parent', 'page_meta_same_host'):
                b += 25.0
            bonus += b
        c.source_bonus = bonus
        c.total_score = c.heuristic_score + c.source_bonus
    return clusters

def resolve(evidence_list: list[dict[str, Any]], current_title: str | None=None) -> ResolvedEvidence:
    evidences = normalize(evidence_list)
    if not evidences:
        empty_cluster = Cluster(normalized_title='', tokens=set(), evidences=[], unique_sources=[], heuristic_score=-9999.0, source_bonus=0.0, total_score=-9999.0)
        return ResolvedEvidence(title='', normalized_title='', winning_cluster=empty_cluster, all_clusters=[], title_sources=[], score={'heuristic_score': -9999.0, 'source_bonus': 0.0, 'total_score': -9999.0}, evidence_count=0)
    evidences.sort(key=lambda e: (e.get('value', ''), e.get('source', '')))
    deduped = deduplicate(evidences)
    clusters = cluster(deduped)
    scored_clusters = score(clusters)

    def cluster_sort_key(c: Cluster) -> tuple[float, float, int, float, int, str]:
        is_current = 1 if current_title and c.normalized_title == current_title.lower().strip() else 0
        return (-c.total_score, -c.heuristic_score, -len(c.unique_sources), -c.source_bonus, -is_current, c.normalized_title)
    scored_clusters.sort(key=cluster_sort_key)
    winning_cluster = scored_clusters[0]
    best_ev: dict[str, Any] | None = None
    best_score = -99999.0
    for ev in winning_cluster.evidences:
        s = score_title(ev['value'])
        if s > best_score:
            best_score = s
            best_ev = ev
        elif s == best_score:
            if best_ev is None or ev['value'] < best_ev['value']:
                best_ev = ev
    title = best_ev['value'] if best_ev else winning_cluster.evidences[0]['value']
    return ResolvedEvidence(title=title, normalized_title=winning_cluster.normalized_title, winning_cluster=winning_cluster, all_clusters=scored_clusters, title_sources=list(winning_cluster.unique_sources), score={'heuristic_score': winning_cluster.heuristic_score, 'source_bonus': winning_cluster.source_bonus, 'total_score': winning_cluster.total_score}, evidence_count=len(winning_cluster.evidences))