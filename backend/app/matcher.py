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
  titulo. Tambien vale un invitado acreditado como "feat." en el titulo de la
  ficha. Sin nada de eso no se empareja: "Creep" de TLC no puede quedarse con
  un directo de Radiohead solo porque el titulo y la duracion se parecen.
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
from .sources import BY_NAME, ITunesSource

log = logging.getLogger("spitifo.matched")

MIN_SCORE = 0.75
DUR_TOL = 12.0       # segundos
DUR_REJECT = 90.0   # mas que esto = live vs studio / remix
#: Similitud minima del titulo: el de la ficha tiene que estar entero.
TITLE_MIN = 0.8
#: Cuanto espera el match a los alias japoneses. Son un extra best effort:
#: pasar este tiempo NO es un fallo, se sigue con la ficha que ya tenemos.
JP_ALIAS_TIMEOUT_S = 2.0

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
#: Creditos "feat." entre parentesis o corchetes en el titulo de la ficha.
#: `core_title` se los saca antes de comparar titulos, pero siguen siendo
#: artistas de la cancion: el canal o el video pueden nombrar solo a ellos.
_FEAT_IN_TITLE = re.compile(
    r"[(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^\)\]]*)[)\]]",
    re.IGNORECASE)


def catalog_status(query: str, items: list[dict]) -> str:
    """Que tan bien cubre el catalogo de iTunes lo que pidio el usuario.

    "none" no hay items; "match" alguno nombra todas las palabras utiles de la
    consulta (en artista, titulo o album); "weak" hay items pero ninguno las
    nombra todas. Acentos y mayusculas se ignoran con `fold`. Sin palabras
    utiles (menos de dos letras) cuenta como match: no hay con que discriminar.
    """
    if not items:
        return "none"
    words = [w for w in (fold(p) for p in (query or "").split()) if len(w) >= 2]
    if not words:
        return "match"
    for it in items:
        text = " ".join(fold(it.get(k)) for k in
                        ("artistName", "trackName", "collectionName"))
        if all(w in text for w in words):
            return "match"
    return "weak"


@lru_cache(maxsize=1024)
def _credits(artist: str) -> tuple[str, ...]:
    return tuple(f for f in (fold(p) for p in _CREDIT_SPLIT.split(artist or "")) if f)


@lru_cache(maxsize=1024)
def _feat_artists(title: str) -> tuple[str, ...]:
    """Invitados acreditados en el titulo: "Refrain (feat. Kasane Teto)"."""
    invitados: list[str] = []
    for grupo in _FEAT_IN_TITLE.findall(title or ""):
        invitados.extend(f for f in (fold(p) for p in _CREDIT_SPLIT.split(grupo)) if f)
    return tuple(invitados)


def credits_artist(name: str, it_artist: str, it_title: str) -> bool:
    """`name` figura en el credito de la ficha o como "feat." en su titulo."""
    wanted = fold(name)
    return bool(wanted) and (wanted in _credits(it_artist)
                             or wanted in _feat_artists(it_title))


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
               v_title: str, v_upl: str, v_dur: float,
               aliases: dict | None = None) -> tuple[float, str]:
    """0..1 + motivo. 0 = sin confianza (no se empareja).

    `aliases` trae los nombres en otra escritura que iTunes da para la MISMA
    pista (storefront jp): "Mesmerizer"/"Satsuki" y "メズマライザー"/"サツキ".
    Cualquiera de las dos escrituras vale; se queda la mejor pareja. Sin alias,
    es exactamente la regla de siempre.
    """
    a = aliases or {}
    titles = [it_title]
    if a.get("title") and fold(a["title"]) != fold(it_title):
        titles.append(a["title"])
    artists = [it_artist]
    if a.get("artist") and fold(a["artist"]) != fold(it_artist):
        artists.append(a["artist"])
    # Los invitados vienen del titulo original: el alias no los repite.
    invitados = _feat_artists(it_title)
    mejor: tuple[float, str] | None = None
    for titulo in titles:
        for artista in artists:
            s, w = _score_pair_one(titulo, artista, it_dur, v_title, v_upl,
                                   v_dur, invitados)
            if mejor is None or s > mejor[0]:
                mejor = (s, w)
    return mejor or (0.0, "sin-señal")


def _score_pair_one(it_title: str, it_artist: str, it_dur: float,
                    v_title: str, v_upl: str, v_dur: float,
                    invitados: tuple[str, ...]) -> tuple[float, str]:
    """Una combinacion titulo/artista. La puerta de artista incluye a los
    invitados del titulo de la ficha: "Refrain (feat. Kasane Teto)" de
    "HAL@修羅場P" bien puede estar en el canal de Teto. El resto no se toca.
    """
    credit = it_artist or ""
    if invitados:
        credit = (f"{credit} & " if credit else "") + " & ".join(invitados)
    chan = channel_matches(credit, v_upl)
    in_title = chan or artist_in(credit, v_title)
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


async def _aliases_for(raw: dict) -> dict:
    """Nombres en japones de una ficha de iTunes. Best effort de verdad:
    ni un fallo de red ni un timeout pueden tumbar la busqueda. La cache vive
    en `sources`, igual que la del resto de iTunes.
    """
    try:
        return await asyncio.wait_for(
            BY_NAME["itunes"].lookup_aliases(raw), timeout=JP_ALIAS_TIMEOUT_S)
    except Exception as e:
        log.warning("matcher: alias jp fallo para %s: %s", raw.get("trackId"), e)
        return {}


async def enrich_with_ytdlp(itunes_tracks: list[dict], query: str,
                             ytdlp_source, limit: int = 40,
                             videos=None) -> list[dict]:
    """Busca los videos de YouTube UNA vez y devuelve idx de {itunes_id: video}.

    Devuelve un indice, no Tracks: el llamador los arma, asi puede mantener
    el resto del pipeline (normalizacion, orden) igual para todas las fuentes.
    `limit` baja el numero de candidatos en busquedas puntuales (un album
    completo necesita 40; una pista suelta, menos). `videos` es la busqueda en
    YouTube ya lanzada (una tarea): el modo Musica la arranca a la vez que la
    de iTunes, porque solo depende de la consulta.
    """
    if not ytdlp_source or not ytdlp_source.available() or not itunes_tracks:
        return {}
    loop = asyncio.get_running_loop()
    try:
        if videos is None:
            videos = await ytdlp_source.search_candidates(query, limit=limit)
        else:
            videos = await videos
    except Exception as e:
        log.warning("matcher: ytdlp search fallo: %s", e)
        return {}

    # Alias japoneses: la ficha suele venir en latin y el video en japones (o
    # al reves). Se piden TODOS a la vez y se guardan en la ficha cruda para
    # que el llamador los tenga tambien al armar el Track del veredicto.
    alias_list = await asyncio.gather(
        *(_aliases_for(it) for it in itunes_tracks), return_exceptions=True)
    for it, alias in zip(itunes_tracks, alias_list):
        if isinstance(alias, dict) and alias:
            it["aliases"] = alias

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
                              v.get("duration") or 0,
                              aliases=it.get("aliases"))
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
