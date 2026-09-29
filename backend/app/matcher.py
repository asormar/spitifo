"""iTunes como catálogo + yt-dlp como motor de descarga.

La idea: iTunes tiene el catalogo mas completo y metadata limpia (titulo
canonico, artista, album, portada, duracion), pero de ahi solo sale un preview
de 30s. yt-dlp si baja el audio entero, pero devuelve rips y covers sin
distinguir. Este modulo los une: busca en iTunes, y para cada pista intenta
encontrar el video de YouTube que *corresponde*.

Por que no simply "el mejor video por titulo": porque varias pistas distintas
comparten titulo. "Bohemian Rhapsody" de Queen, de Panic! At the Disco y de
Pentatonix. Con matching ingenuo las tres acababan en el video de Queen.

Reglas del matching (verificadas con probe_matching.py):
- el CANAL del video tiene que contener el nombre del artista, O
- el titulo tiene que coincidir Y la duracion estar dentro de 12s
- si no hay ninguna de esas señales: NO matchear. Es preferible decir "sin
  version descargable" que bajar la cancion equivocada.
- un video no se reutiliza para dos pistas distintas
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from .identify import similarity
from .models import Track
from .sources import ITunesSource

log = logging.getLogger("spitifo.matched")

MIN_SCORE = 0.75
DUR_TOL = 12.0       # segundos
DUR_REJECT = 90.0   # mas que esto = live vs studio / remix


def _norm(s: str) -> str:
    return "".join(c for c in (s or "").lower() if c.isalnum() or c.isspace())


def channel_matches(artist: str, uploader: str) -> bool:
    """El canal de YouTube contiene el nombre del artista de iTunes."""
    a = _norm(artist).split()
    u = _norm(uploader)
    if not a or not u:
        return False
    return a[0] in u


def score_pair(it_title: str, it_artist: str, it_dur: float,
               v_title: str, v_upl: str, v_dur: float) -> tuple[float, str]:
    """0..1 + motivo. 0 = sin confianza."""
    title_sim = similarity(it_title, v_title)
    chan = channel_matches(it_artist, v_upl)
    dur_ok = bool(it_dur and v_dur and abs(it_dur - v_dur) <= DUR_TOL)

    # sin canal Y sin (titulo+duracion) no hay confianza: no matchear
    if not chan and not (title_sim >= 0.8 and dur_ok):
        return 0.0, "sin-señal"

    if it_dur and v_dur and abs(it_dur - v_dur) > DUR_REJECT:
        return 0.0, "duración muy distinta"

    score = title_sim
    if chan:
        score = min(1.0, score + 0.3)
    if dur_ok:
        score = min(1.0, score + 0.2)
    why = ("canal" if chan else "") + ("+dur" if dur_ok else "")
    return score, (why or "titulo")


async def enrich_with_ytdlp(itunes_tracks: list[dict], query: str,
                             ytdlp_source) -> list[dict]:
    """Busca los videos de YouTube UNA vez y devuelve idx de {itunes_id: video}.

    Devuelve un indice, no Tracks: el llamador los arma, asi puede mantener
    el resto del pipeline (normalizacion, orden) igual para todas las fuentes.
    """
    if not ytdlp_source or not ytdlp_source.available() or not itunes_tracks:
        return {}
    loop = asyncio.get_running_loop()
    try:
        videos = await ytdlp_source.search_candidates(query, limit=40)
    except Exception as e:
        log.warning("matcher: ytdlp search fallo: %s", e)
        return {}

    used: set[str] = set()
    matched: dict[str, dict] = {}
    for it in itunes_tracks:
        title = it.get("trackName", "")
        artist = it.get("artistName", "")
        dur = (it.get("trackTimeMillis") or 0) / 1000
        best, best_s, why = None, 0.0, ""
        for v in videos:
            if v.get("id") in used:
                continue
            s, w = score_pair(title, artist, dur,
                             v.get("title") or "",
                             v.get("uploader") or v.get("channel") or "",
                             v.get("duration") or 0)
            if s > best_s:
                best, best_s, why = v, s, w
        key = str(it.get("trackId") or it.get("collectionId") or title)
        if best and best_s >= MIN_SCORE:
            used.add(best.get("id"))
            matched[key] = {
                "video": best, "score": round(best_s, 2), "why": why,
                "webpage_url": best.get("webpage_url") or
                f"https://www.youtube.com/watch?v={best['id']}",
            }
        else:
            matched[key] = {"video": None, "score": round(best_s, 2),
                            "why": why or "sin-señal"}
    return matched
