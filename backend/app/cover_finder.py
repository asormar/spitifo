"""«Buscar portadas»: portadas de iTunes para los temas que no tienen una.

Los audios bajados antes de las portadas no tienen `<stem>.jpg` al lado. Esta
herramienta NO rellena nada sola: lista esos temas, busca candidatas en iTunes
y guarda solo la que el usuario confirma, archivo por archivo.

Regla de verdad: una portada guardada tiene que salir de un resultado real de
iTunes para ESE tema. Por eso el backend recuerda que URLs ofrecio para cada
clave (un rato) y rechaza guardar cualquier otra, aunque sea de iTunes.

Se guarda igual que en la descarga: `<stem>.jpg` (200 px) y `<stem>.s.jpg`
(100 px) con `fetch_itunes_covers`, en un solo `put_files` (en Drive, una
escritura del indice). El veredicto del archivo (`fileinfo`) no se toca: habla
del audio, y una portada no lo cambia.
"""
from __future__ import annotations

import asyncio
import shutil
import tempfile
import threading
import time
import weakref
from pathlib import Path

from .config import AUDIO_EXTS
from .covers import fetch_itunes_covers, itunes_cover_urls
from .downloader import TEMP_DIR, _thumb_sidecar, library_scan, thumb_small_sidecar
from .storage import InvalidKey, get_storage

#: Candidatas que se muestran por tema.
MAX_CANDIDATES = 6
#: Resultados que se le piden a iTunes: algunos se caen (sin portada, repetidos).
SEARCH_LIMIT = 25
#: Cuanto vale una oferta: lo que tarda en decidir alguien que se distrajo.
OFFER_TTL_S = 15 * 60
MAX_QUERY = 200


class CoverError(Exception):
    """Fallo con codigo HTTP: la ruta lo traduce tal cual."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class Offers:
    """URLs de portada ofrecidas por clave, con vencimiento."""

    def __init__(self, ttl: float = OFFER_TTL_S, clock=time.monotonic) -> None:
        self._ttl = ttl
        self._clock = clock
        self._lock = threading.Lock()
        self._by_key: dict[str, tuple[float, set[str]]] = {}

    def remember(self, key: str, urls: list[str]) -> None:
        """Suma `urls` a lo ofrecido para `key` (otra busqueda no borra la anterior)."""
        now = self._clock()
        with self._lock:
            self._prune(now)
            old = self._by_key.get(key)
            known = set(old[1]) if old else set()
            self._by_key[key] = (now, known | set(urls))

    def offered(self, key: str, url: str) -> bool:
        with self._lock:
            self._prune(self._clock())
            hit = self._by_key.get(key)
            return bool(hit and url in hit[1])

    def forget(self, key: str) -> None:
        with self._lock:
            self._by_key.pop(key, None)

    def _prune(self, now: float) -> None:
        for key in [k for k, (at, _) in self._by_key.items()
                    if now - at > self._ttl]:
            del self._by_key[key]


OFFERS = Offers()
#: Un guardado a la vez: dos toques rapidos no suben la misma portada dos veces.
#: Un lock por event loop: un `asyncio.Lock` queda atado al loop que lo usa.
_APPLY_LOCKS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" = (
    weakref.WeakKeyDictionary())


def _apply_lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lock = _APPLY_LOCKS.get(loop)
    if lock is None:
        lock = _APPLY_LOCKS[loop] = asyncio.Lock()
    return lock


def suggested_query(row: dict) -> str:
    """«artista titulo» de las etiquetas; sin titulo, el nombre del archivo."""
    title = (row.get("title") or "").strip()
    artist = (row.get("artist") or "").strip()
    if title:
        return f"{artist} {title}".strip()
    stem = Path(row.get("filename") or "").stem
    return " ".join(stem.replace("_", " ").split())


def missing() -> list[dict]:
    """Temas de audio sin portada, en el orden de la biblioteca (nuevos primero).

    Los videos no entran: su miniatura sale de YouTube, no de iTunes.
    """
    out = []
    for row in library_scan():
        if row.get("kind") != "audio" or row.get("thumb_key"):
            continue
        out.append({
            "key": row["key"],
            "filename": row["filename"],
            "folder": row["folder"],
            "title": row.get("title"),
            "artist": row.get("artist"),
            "album": row.get("album"),
            "query": suggested_query(row),
        })
    return out


def _candidate(item: dict) -> dict | None:
    """Una cancion de iTunes con portada valida, o None."""
    art = (item.get("artworkUrl100") or "").replace("100x100", "300x300")
    if itunes_cover_urls(art) is None:
        return None
    year = (item.get("releaseDate") or "")[:4]
    return {
        "title": item.get("trackName") or "",
        "artist": item.get("artistName") or "",
        "album": item.get("collectionName") or "",
        "year": year if year.isdigit() else None,
        "artwork_url": art,
    }


async def _itunes_search(q: str) -> list[dict]:
    """Canciones crudas de iTunes. Aparte para poder reemplazarla en los tests."""
    from .sources import ITunesSource
    source = ITunesSource()
    try:
        return await source._raw_search(q, limit=SEARCH_LIMIT)
    finally:
        await source.aclose()


async def candidates(key: str, q: str) -> list[dict]:
    """Hasta `MAX_CANDIDATES` canciones de iTunes con portada para `key`.

    Sin preseleccion: el orden es el de iTunes. Cada portada ofrecida queda
    anotada para esa clave; `apply` solo acepta esas.
    """
    q = " ".join((q or "").split())
    if not q:
        raise CoverError(422, "la busqueda esta vacia")
    if len(q) > MAX_QUERY:
        raise CoverError(422, "la busqueda es demasiado larga")
    await _check_audio_without_cover(key)
    try:
        raw = await _itunes_search(q)
    except Exception as e:
        raise CoverError(502, f"iTunes no respondio: {e}") from e
    out: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        found = _candidate(item)
        if found is None or found["artwork_url"] in seen:
            continue
        seen.add(found["artwork_url"])
        out.append(found)
        if len(out) == MAX_CANDIDATES:
            break
    OFFERS.remember(key, [c["artwork_url"] for c in out])
    return out


def _exists(storage, key: str) -> bool:
    try:
        storage.stat(key)
        return True
    except FileNotFoundError:
        return False


async def _check_audio_without_cover(key: str) -> None:
    """404 si el tema no existe o no es audio; 409 si ya tiene portada."""
    if not isinstance(key, str) or Path(key).suffix.lower() not in AUDIO_EXTS:
        raise CoverError(404, "no encontrado")
    storage = get_storage()
    try:
        if not await asyncio.to_thread(_exists, storage, key):
            raise CoverError(404, "no encontrado")
        if await asyncio.to_thread(_exists, storage, _thumb_sidecar(key)):
            raise CoverError(409, "este tema ya tiene portada")
    except (InvalidKey, OSError) as e:
        raise CoverError(404, "no encontrado") from e


async def apply(key: str, artwork_url: str) -> dict:
    """Guarda la portada confirmada de `key`: las dos o ninguna."""
    if not isinstance(artwork_url, str) or not OFFERS.offered(key, artwork_url):
        raise CoverError(400, "esa portada no salio de una busqueda para este tema")
    async with _apply_lock():
        await _check_audio_without_cover(key)
        work = Path(tempfile.mkdtemp(dir=TEMP_DIR))
        try:
            covers = await fetch_itunes_covers(artwork_url, work)
            if covers is None:
                raise CoverError(502, "no se pudo bajar la portada de iTunes")
            big, small = _thumb_sidecar(key), thumb_small_sidecar(key)
            items = [(big, covers[0]), (small, covers[1])]
            try:
                await asyncio.to_thread(get_storage().put_files, items)
            except Exception as e:
                raise CoverError(502, f"no se pudo guardar la portada: {e}") from e
        finally:
            shutil.rmtree(work, ignore_errors=True)
    OFFERS.forget(key)
    return {"key": key, "thumb_key": big, "thumb_s": True}
