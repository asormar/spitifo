"""Recomendaciones de Discover: funciones puras (ADR 0003, decision 5).

No tocan la red ni el storage: reciben la biblioteca, las fichas de artistas,
el resumen de escucha y los descartes, y devuelven los generos del usuario y
los artistas candidatos. Asi se pueden probar enteras sin dobles de red.

Formas:

    library   {folded: {"name": str, "tracks": int}}
    records   {folded: {name, mbid, genres: [[name, count]], similar: [...],
                        fetched_at, status}}
    tracks    load_listens_summary()["tracks"] -> {key: {score, ...}}
    dismissed set de nombres plegados
"""
from __future__ import annotations

import math

from .artistinfo import artist_name, fold, split_artists

#: Tope de generos del perfil y de candidatos devueltos.
MAX_USER_GENRES = 8
MAX_CANDIDATES = 20
MAX_CANDIDATE_GENRES = 3
MAX_BECAUSE = 2
#: Cada candidato nuevo que repite el seed principal del anterior pesa menos:
#: 0.6 por vez. Sin esto tres seeds que se solapan llenan toda la lista.
DIVERSITY_DECAY = 0.6


def _tracks(info: object) -> int:
    if not isinstance(info, dict):
        return 0
    value = info.get("tracks")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return max(0, int(value))


def _score(metric: object) -> float:
    if not isinstance(metric, dict):
        return 0.0
    value = metric.get("score")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    return max(0.0, float(value))


def _name_of(info: object) -> str:
    """Nombre visible de un artista de la biblioteca."""
    if isinstance(info, dict):
        name = info.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    return ""


def _genre_counts(record: object) -> list[tuple[str, float]]:
    """`[(name, count)]` validos de una ficha."""
    raw = record.get("genres") if isinstance(record, dict) else None
    out: list[tuple[str, float]] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        name, count = item[0], item[1]
        if not isinstance(name, str) or not name.strip():
            continue
        if isinstance(count, bool) or not isinstance(count, (int, float)):
            continue
        if count <= 0:
            continue
        out.append((name.strip(), float(count)))
    return out


def artist_weights(library: dict, entries: list[dict],
                   tracks: dict | None = None) -> dict[str, float]:
    """Peso de cada artista de la biblioteca.

    `log1p(pistas en la biblioteca)` mas la suma del `score` de escucha de sus
    pistas. Las claves del historial se resuelven con la entrada de la
    biblioteca (por la etiqueta `artist`) y, si la pista ya no esta, con la
    misma regla sobre la clave sola. Un credito de colaboracion reparte la
    escucha entre TODOS sus artistas.
    """
    by_key: dict[str, list[str]] = {}
    for entry in entries or ():
        if not isinstance(entry, dict):
            continue
        key = entry.get("key")
        if not isinstance(key, str) or not key:
            continue
        folded = [fold(part) for part in split_artists(artist_name(entry))]
        folded = [part for part in folded if part]
        if folded:
            by_key[key] = folded
    listened: dict[str, float] = {}
    for key, metric in (tracks or {}).items():
        if not isinstance(key, str):
            continue
        folded_parts = by_key.get(key)
        if folded_parts is None:
            folded_parts = [fold(part) for part
                            in split_artists(artist_name({"key": key}))]
        contribution = _score(metric)
        for folded in folded_parts:
            if not folded or folded not in library:
                continue
            listened[folded] = listened.get(folded, 0.0) + contribution
    return {folded: math.log1p(_tracks(info)) + listened.get(folded, 0.0)
            for folded, info in library.items()}


def user_genres(library: dict, records: dict,
                weights: dict[str, float],
                limit: int = MAX_USER_GENRES) -> list[dict]:
    """Generos del perfil: `[{name, share}]`, de mas a menos y normalizados.

    Cada artista reparte su peso entre sus generos segun el count de
    MusicBrainz (`w * count / total del artista`). Los shares se normalizan a 1
    sobre los generos que se devuelven.
    """
    totals: dict[str, float] = {}
    for folded, info in library.items():
        pairs = _genre_counts(records.get(folded))
        total = sum(count for _, count in pairs)
        weight = weights.get(folded, 0.0)
        if total <= 0 or weight <= 0:
            continue
        for name, count in pairs:
            totals[name] = totals.get(name, 0.0) + weight * count / total
    top = sorted(totals.items(), key=lambda item: (-item[1], item[0]))[:limit]
    overall = sum(value for _, value in top)
    if overall <= 0:
        return []
    return [{"name": name, "share": value / overall} for name, value in top]


def candidates(library: dict, records: dict, weights: dict[str, float],
               dismissed=(), limit: int = MAX_CANDIDATES) -> list[dict]:
    """Artistas recomendados, de mas a menos y con score normalizado a 0..1.

    Cada artista de la biblioteca aporta sus similares: `w * score / max score
    de su lista`. Se descartan los que ya estan en la biblioteca (por nombre
    plegado) y los descartados por el usuario. `because` son los hasta dos
    artistas de la biblioteca que mas aportaron.
    """
    dismissed_keys = {fold(name) for name in (dismissed or ())
                      if isinstance(name, str)}
    best: dict[str, dict] = {}
    for folded in sorted(library):
        record = records.get(folded)
        if not isinstance(record, dict):
            continue
        raw = record.get("similar")
        if not isinstance(raw, list):
            continue
        weight = weights.get(folded, 0.0)
        if weight <= 0:
            continue
        rows: dict[str, tuple[str, str | None, float]] = {}
        for similar in raw:
            if not isinstance(similar, dict):
                continue
            name, mbid = similar.get("name"), similar.get("mbid")
            score = similar.get("score")
            if not isinstance(name, str) or not name.strip():
                continue
            if isinstance(score, bool) or not isinstance(score, (int, float)):
                continue
            if score <= 0:
                continue
            key = fold(name)
            if not key or key in library or key in dismissed_keys:
                continue
            previous = rows.get(key)
            if previous is None or score > previous[2]:
                rows[key] = (name.strip(),
                             mbid if isinstance(mbid, str) and mbid else None,
                             float(score))
        if not rows:
            continue
        peak = max(score for _, _, score in rows.values())
        if peak <= 0:
            continue
        for key, (name, mbid, score) in rows.items():
            hit = best.setdefault(key, {"name": name, "mbid": None,
                                        "score": 0.0, "by": {}})
            contribution = weight * score / peak
            hit["score"] += contribution
            if hit["mbid"] is None and mbid:
                hit["mbid"] = mbid
            previous = hit["by"].get(folded)
            if previous is None or contribution > previous:
                hit["by"][folded] = contribution

    out: list[dict] = []
    for key, hit in best.items():
        ordered = sorted(hit["by"].items(), key=lambda item: (-item[1], item[0]))
        because = [_name_of(library[artist]) or artist
                   for artist, _ in ordered[:MAX_BECAUSE] if artist in library]
        genres = [name for name, _ in _genre_counts(records.get(key))
                  ][:MAX_CANDIDATE_GENRES]
        out.append({"name": hit["name"], "mbid": hit["mbid"],
                    "score": hit["score"], "because": because,
                    "genres": genres,
                    # Seed principal: el artista que mas aporto. No se devuelve.
                    "_seed": ordered[0][0] if ordered else ""})
    out.sort(key=lambda item: (-item["score"], item["name"]))
    top = _diversify(out, limit)
    if not top:
        return []
    peak = max(item["score"] for item in top)
    if peak > 0:
        for item in top:
            item["score"] = item["score"] / peak
    for item in top:
        item.pop("_seed", None)
    return top


def _diversify(items: list[dict], limit: int) -> list[dict]:
    """Re-rankea de a uno penalizando al seed que ya gano.

    El mejor candidato restante es el de mayor `score * 0.6 ** (veces que ya
    salio su seed principal)`. El score que se devuelve es el normalizado
    original: la penalizacion solo decide el ORDEN.
    """
    def rank(item: dict, counts: dict[str, int]) -> tuple[float, str]:
        weighted = (item["score"]
                    * DIVERSITY_DECAY ** counts.get(item["_seed"], 0))
        return (-weighted, item["name"])

    remaining = list(items)
    picked: list[dict] = []
    counts: dict[str, int] = {}
    while remaining and len(picked) < limit:
        best = min(remaining, key=lambda item: rank(item, counts))
        remaining.remove(best)
        picked.append(best)
        counts[best["_seed"]] = counts.get(best["_seed"], 0) + 1
    return picked
