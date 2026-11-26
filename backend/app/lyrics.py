"""Letra sincronizada via LRCLIB (https://lrclib.net), sin API key.

Primero un lookup exacto (titulo+artista+album+duracion); si falla, una
busqueda y se elige el mejor candidato por duracion y similitud de titulo/
artista (con `identify.similarity`). Alias (titulo/artista alternativos, por
ejemplo el nombre en japones que ya trae el caller) se prueban en orden antes
de rendirse. Un fallo de red nunca se propaga: lo resuelve la ruta con nulls.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
import weakref

import httpx

from .config import USER_AGENT
from .identify import fold, similarity

log = logging.getLogger("spitifo.lyrics")

LRCLIB_BASE = "https://lrclib.net/api"
_HEADERS = {"User-Agent": USER_AGENT}

#: Timeout por pedido HTTP (exacto o busqueda) y presupuesto TOTAL de la ruta:
#: varios pedidos (exacto + busqueda + alias) no pueden sumar mas de esto.
REQUEST_TIMEOUT = httpx.Timeout(3.0, connect=2.0)
TOTAL_TIMEOUT_S = 4.0

#: Tolerancia de duracion al elegir el mejor candidato de una busqueda.
DURATION_TOLERANCE_S = 3
#: Sin duracion para filtrar, hace falta igual una similitud minima: evita
#: devolver la letra de una cancion sin relacion solo porque fue el primer
#: resultado de LRCLIB.
MIN_SIMILARITY_SIN_DURACION = 0.5


def _make_client() -> httpx.AsyncClient:
    """Fabrica del cliente HTTP: un punto unico que los tests pueden reemplazar
    (monkeypatch.setattr(lyrics, '_make_client', ...)) para inyectar un
    httpx.MockTransport sin tocar la red."""
    return httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True,
                             headers=_HEADERS)


# --------------------------------------------------------------- parsing LRC
# Una etiqueta de tiempo es [mm:ss] o [mm:ss.ff]; las de metadata ([ar:...],
# [ti:...], [al:...], [offset:...]) no tienen digitos en el primer grupo y por
# eso el regex nunca las matchea: se saltean solas, no hace falta una lista.
_LRC_TAG_RE = re.compile(r"\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]")


def parse_lrc(text: str | None) -> list[dict]:
    """`syncedLyrics` de LRCLIB -> lista de {"t": segundos, "line": texto},
    ordenada por tiempo. Una linea puede traer varias etiquetas de tiempo
    (el mismo verso se repite en distintos momentos de la cancion): cada una
    se vuelve su propia entrada con el mismo texto."""
    if not text:
        return []
    filas: list[dict] = []
    for cruda in text.splitlines():
        linea = cruda.strip()
        if not linea:
            continue
        etiquetas = list(_LRC_TAG_RE.finditer(linea))
        if not etiquetas:
            continue  # metadata ([ar:], [ti:]...) u otra basura sin timestamp
        texto = linea[etiquetas[-1].end():].strip()
        for et in etiquetas:
            minutos = int(et.group(1))
            segundos = float(et.group(2))
            filas.append({"t": round(minutos * 60 + segundos, 2), "line": texto})
    filas.sort(key=lambda f: f["t"])
    return filas


# ------------------------------------------------------------------- LRCLIB
async def _get_exacto(client: httpx.AsyncClient, title: str, artist: str,
                      album: str, duration: int) -> dict | None:
    """GET /api/get: None si LRCLIB no tiene esa pista exacta (404)."""
    r = await client.get(f"{LRCLIB_BASE}/get", params={
        "track_name": title, "artist_name": artist,
        "album_name": album, "duration": duration,
    })
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


async def _buscar(client: httpx.AsyncClient, title: str, artist: str) -> list[dict]:
    """GET /api/search: lista de candidatos (vacia si no hay nada)."""
    r = await client.get(f"{LRCLIB_BASE}/search", params={
        "track_name": title, "artist_name": artist,
    })
    r.raise_for_status()
    datos = r.json()
    return datos if isinstance(datos, list) else []


def _elegir_mejor(candidatos: list[dict], title: str, artist: str,
                  duration: int | None) -> dict | None:
    """El candidato mas parecido, filtrando antes por duracion si se conoce."""
    mejor, mejor_score = None, -1.0
    for c in candidatos:
        c_dur = c.get("duration")
        if duration is not None:
            if c_dur is None or abs(c_dur - duration) > DURATION_TOLERANCE_S:
                continue
        score = similarity(f"{title} {artist}",
                           f"{c.get('trackName') or ''} {c.get('artistName') or ''}")
        if duration is None and score < MIN_SIMILARITY_SIN_DURACION:
            continue
        if score > mejor_score:
            mejor_score, mejor = score, c
    return mejor


async def _lookup_uno(client: httpx.AsyncClient, title: str, artist: str,
                      album: str | None, duration: int | None) -> dict | None:
    """Exacto (si hay album+duracion) y, si no hay nada, busqueda. None = nada util."""
    track = None
    if album and duration is not None:
        track = await _get_exacto(client, title, artist, album, duration)
    if track is None:
        candidatos = await _buscar(client, title, artist)
        track = _elegir_mejor(candidatos, title, artist, duration)
    return track


def _resultado(track: dict | None, *, error: str | None = None) -> dict:
    if track is None:
        return {"synced": None, "plain": None, "instrumental": False,
                "source": None, **({"error": error} if error else {})}
    return {
        "synced": parse_lrc(track.get("syncedLyrics")) or None,
        "plain": track.get("plainLyrics") or None,
        "instrumental": bool(track.get("instrumental")),
        "source": "lrclib",
    }


async def _fetch(title: str, artist: str, album: str | None, duration: int | None,
                 alt_titles: list[str], alt_artists: list[str]) -> dict:
    """Prueba (title, artist) y, si no hay nada, cada alias en orden (una
    busqueda para canciones japonesas donde el titulo/artista en latino no
    tiene match pero el alias en japones si)."""
    intentos = [(title, artist)]
    n_alt = max(len(alt_titles), len(alt_artists))
    for i in range(n_alt):
        at = alt_titles[i] if i < len(alt_titles) else title
        aa = alt_artists[i] if i < len(alt_artists) else artist
        if (at, aa) not in intentos:
            intentos.append((at, aa))

    async with _make_client() as client:
        for t, a in intentos:
            track = await _lookup_uno(client, t, a, album, duration)
            if track is not None:
                return _resultado(track)
    return _resultado(None)


# -------------------------------------------------------------------- cache
# Hits 7 dias, fallos 1 dia (no hace falta repetir la busqueda en cada visita
# a la cancion, pero tampoco guardar para siempre una letra que no existe).
# Acotada y con el mismo desalojo por antiguedad que las demas caches del
# backend. Un fallo de red NO se cachea: el proximo pedido reintenta.
_CACHE: dict[tuple, tuple[float, dict, bool]] = {}
_CACHE_MAX = 500
_HIT_TTL_S = 7 * 24 * 3600
_MISS_TTL_S = 24 * 3600
_clock = time.time

# Un lock por clave (y por loop, como `_ARTIST_TOP_LOCKS` en main.py): dos
# pedidos concurrentes de la misma cancion comparten un solo pedido de red.
_LOCKS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[tuple, asyncio.Lock]]" = (
    weakref.WeakKeyDictionary())


def _key_lock(clave: tuple) -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    por_clave = _LOCKS.get(loop)
    if por_clave is None:
        por_clave = _LOCKS[loop] = {}
    lock = por_clave.get(clave)
    if lock is None:
        lock = por_clave[clave] = asyncio.Lock()
    return lock


def _cache_key(title: str, artist: str, duration: int | None) -> tuple:
    return (fold(title), fold(artist),
           round(duration) if duration is not None else None)


def cache_clear() -> None:
    """Para que un test no filtre al siguiente (fixture autouse en conftest)."""
    _CACHE.clear()


def _cache_get(clave: tuple) -> dict | None:
    hit = _CACHE.get(clave)
    if not hit:
        return None
    guardado, resultado, acierto = hit
    ttl = _HIT_TTL_S if acierto else _MISS_TTL_S
    if _clock() - guardado >= ttl:
        _CACHE.pop(clave, None)
        return None
    return resultado


def _cache_put(clave: tuple, resultado: dict, *, acierto: bool) -> None:
    _CACHE[clave] = (_clock(), resultado, acierto)
    if len(_CACHE) > _CACHE_MAX:
        vieja = min(_CACHE, key=lambda k: _CACHE[k][0])
        _CACHE.pop(vieja, None)


async def get_lyrics(*, title: str, artist: str, album: str | None = None,
                     duration: int | None = None,
                     alt_titles: list[str] | None = None,
                     alt_artists: list[str] | None = None) -> dict:
    """{"synced": [...]|None, "plain": str|None, "instrumental": bool,
    "source": "lrclib"|None} y, si LRCLIB no respondio, tambien
    `"error": "unavailable"`. Nunca tira: un fallo de red da nulls, no 500."""
    alt_titles = alt_titles or []
    alt_artists = alt_artists or []
    clave = _cache_key(title, artist, duration)

    cacheado = _cache_get(clave)
    if cacheado is not None:
        return cacheado

    async with _key_lock(clave):
        # mientras esperabamos el lock, otro pedido pudo llenar la cache
        cacheado = _cache_get(clave)
        if cacheado is not None:
            return cacheado

        try:
            resultado = await asyncio.wait_for(
                _fetch(title, artist, album, duration, alt_titles, alt_artists),
                timeout=TOTAL_TIMEOUT_S)
        except (httpx.HTTPError, asyncio.TimeoutError) as e:
            log.warning("lyrics: LRCLIB no respondio: %s", e)
            return _resultado(None, error="unavailable")

        _cache_put(clave, resultado, acierto=resultado.get("source") is not None)
        return resultado
