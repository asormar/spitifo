"""iTunes como catálogo + yt-dlp como motor de descarga.

La idea: iTunes tiene el catalogo mas completo y metadata limpia (titulo
canonico, artista, album, portada, duracion), pero de ahi solo sale un preview
de 30s. yt-dlp si baja el audio entero, pero devuelve rips y covers sin
distinguir. Este modulo los une: busca en iTunes, y para cada pista intenta
encontrar el video de YouTube que *corresponde*.

Por que no simply "el mejor video por titulo": porque varias pistas distintas
comparten titulo. "Bohemian Rhapsody" de Queen, de Panic! At the Disco y de
Pentatonix. Con matching ingenuo las tres acababan en el video de Queen.

Reglas del matching:
- el video tiene que nombrar al ARTISTA de la ficha, en el canal o en el
  titulo. Sin eso no se empareja: "Creep" de TLC no puede quedarse con un
  directo de Radiohead solo porque el titulo y la duracion se parecen.
- el titulo de la ficha tiene que estar ENTERO en el del video ("La Fama" no
  vale para "La Yugular" aunque compartan "la").
- un video que es otra version (en directo, cover, remix, karaoke...) que la
  ficha no pide se descarta.
- duracion: dentro de 12 s suma; a mas de 90 s se descarta.
- un video no se reutiliza para dos pistas distintas, y el reparto es global:
  cada video va a la pista con la que mejor encaja, no a la primera de la lista.
Es preferible decir "sin version descargable" que bajar la cancion equivocada.
"""
from __future__ import annotations

import asyncio
import logging
import re
from functools import lru_cache
from typing import Any

import httpx

from .identify import fold, similarity, version_conflict, version_markers
from .models import Track
from .sources import ITunesSource

log = logging.getLogger("spitifo.matched")

MIN_SCORE = 0.75
DUR_TOL = 12.0       # segundos
DUR_REJECT = 90.0   # mas que esto = live vs studio / remix
#: Similitud minima del titulo: el de la ficha tiene que estar entero.
TITLE_MIN = 0.8

#: Separadores de artistas en un credito de iTunes ("ROSALÍA & Rauw Alejandro",
#: "Bad Bunny feat. Chencho", "Karol G, Shakira").
_CREDIT_SPLIT = re.compile(r"\s*(?:&|,|\+|/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b)\s*",
                           re.IGNORECASE)
#: Palabras que no identifican a un artista ("The Beatles" es "beatles").
_ARTIST_STOP = {"the", "a", "an", "los", "las", "el", "la", "les"}
#: Videos de letra o subtitulados: suelen llevar el audio original, pero un
#: canal cualquiera puede haberlo tocado. Se aceptan con menos puntaje.
_SOFT = re.compile(r"(?<!\w)(lyrics?|letra|sub(titulad[oa])?s?|traducid[oa]|"
                   r"vietsub|romaji|color coded|legendado)(?!\w)")
#: Lo que se le saca al titulo de la ficha antes de comparar: remasters,
#: anios y artistas invitados no cambian la cancion.
_ITUNES_QUALIFIER = re.compile(
    r"\s*(?:[\(\[][^\)\]]*(?:remaster|feat\.?|ft\.|with |\b\d{4}\b|mono|stereo)"
    r"[^\)\]]*[\)\]]|-\s*(?:\d{4}\s*)?remaster(?:ed)?(?:\s*\d{4})?\s*$"
    r"|-\s*\d{4}\s+(?:mix|version|stereo mix|mono)\s*$)",
    re.IGNORECASE)


@lru_cache(maxsize=1024)
def _credits(artist: str) -> tuple[str, ...]:
    return tuple(f for f in (fold(p) for p in _CREDIT_SPLIT.split(artist or "")) if f)


def credited_artists(artist: str) -> list[str]:
    """Los artistas de un credito, ya plegados: "ROSALÍA & The Weeknd" ->
    ["rosalia", "the weeknd"]."""
    return list(_credits(artist))


def _artist_key(name: str) -> str:
    toks = [t for t in name.split() if t not in _ARTIST_STOP] or name.split()
    return "".join(toks)


def artist_in(artist: str, text: str) -> bool:
    """Algun artista del credito aparece en `text` (canal o titulo del video).

    Se compara sin espacios para aceptar canales como "LinkinParkOfficialVEVO".
    Un nombre muy corto ("U2", "TLC") tiene que aparecer como palabra suelta:
    como subcadena saldria en cualquier lado.
    """
    t = fold(text)
    if not t:
        return False
    t_ns = t.replace(" ", "")
    for name in _credits(artist):
        key = _artist_key(name)
        if len(key) <= 3:
            if re.search(rf"(?<!\w){re.escape(key)}(?!\w)", t):
                return True
        elif key in t_ns or name.replace(" ", "") in t_ns:
            return True
    return False


def channel_matches(artist: str, uploader: str) -> bool:
    """El canal de YouTube nombra a algun artista de la ficha de iTunes."""
    return artist_in(artist, uploader)


@lru_cache(maxsize=1024)
def core_title(title: str) -> str:
    """Titulo de la ficha sin remaster, anio ni invitados."""
    return _ITUNES_QUALIFIER.sub("", title or "").strip() or (title or "")


def score_pair(it_title: str, it_artist: str, it_dur: float,
               v_title: str, v_upl: str, v_dur: float) -> tuple[float, str]:
    """0..1 + motivo. 0 = sin confianza (no se empareja)."""
    chan = channel_matches(it_artist, v_upl)
    in_title = chan or artist_in(it_artist, v_title)
    if not in_title:
        return 0.0, "sin-artista"

    wanted = core_title(it_title)
    title_sim = similarity(wanted, v_title)
    if title_sim < TITLE_MIN:
        return 0.0, "otro-titulo"

    if version_conflict(it_title, v_title):
        return 0.0, "otra-version"

    if it_dur and v_dur and abs(it_dur - v_dur) > DUR_REJECT:
        return 0.0, "duración muy distinta"
    dur_ok = bool(it_dur and v_dur and abs(it_dur - v_dur) <= DUR_TOL)

    # El canal del artista vale mas que un canal cualquiera que lo nombra.
    score = 0.6 * title_sim + (0.2 if chan else 0.1) + (0.2 if dur_ok else 0.0)
    # La ficha pide una version (p. ej. "Live") que el video no dice ser.
    if version_markers(it_title) - version_markers(v_title):
        score -= 0.15
    soft = bool(_SOFT.search(fold(v_title)))
    if soft:
        score -= 0.1
    why = ("canal" if chan else "titulo") + ("+dur" if dur_ok else "") + ("+letra" if soft else "")
    return round(max(0.0, min(1.0, score)), 4), why


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

    # Todas las parejas posibles y despues el reparto: de mejor a peor puntaje,
    # cada pista y cada video se usan una vez. Recorrer las pistas en orden y
    # darle a cada una su mejor video dejaba a la primera quedarse con el video
    # que encajaba mejor con otra.
    keys = [str(it.get("trackId") or it.get("collectionId") or it.get("trackName", ""))
            for it in itunes_tracks]
    pairs: list[tuple[float, int, int, str]] = []
    best_miss: dict[str, tuple[float, str]] = {}
    for ti, it in enumerate(itunes_tracks):
        title = it.get("trackName", "")
        artist = it.get("artistName", "")
        dur = (it.get("trackTimeMillis") or 0) / 1000
        for vi, v in enumerate(videos):
            s, w = score_pair(title, artist, dur,
                              v.get("title") or "",
                              v.get("uploader") or v.get("channel") or "",
                              v.get("duration") or 0)
            if s >= MIN_SCORE:
                pairs.append((s, ti, vi, w))
            elif s > best_miss.get(keys[ti], (-1.0, ""))[0]:
                best_miss[keys[ti]] = (s, w)
    # orden estable: a igual puntaje, la pista que iTunes puso antes y el video
    # que YouTube puso antes
    pairs.sort(key=lambda p: (-p[0], p[1], p[2]))

    used_t: set[int] = set()
    used_v: set[int] = set()
    matched: dict[str, dict] = {}
    for s, ti, vi, w in pairs:
        if ti in used_t or vi in used_v:
            continue
        used_t.add(ti)
        used_v.add(vi)
        best = videos[vi]
        matched[keys[ti]] = {
            "video": best, "score": round(s, 2), "why": w,
            "webpage_url": best.get("webpage_url") or
            f"https://www.youtube.com/watch?v={best['id']}",
        }
    with_pair = {p[1] for p in pairs}
    for ti, key in enumerate(keys):
        if ti not in used_t and key not in matched:
            # tenia candidato, pero se lo llevo otra pista que encajaba mejor
            s, w = ((0.0, "video-ya-usado") if ti in with_pair
                    else best_miss.get(key, (0.0, "sin-señal")))
            matched[key] = {"video": None, "score": round(s, 2), "why": w or "sin-señal"}
    return matched
