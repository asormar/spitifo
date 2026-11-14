"""Portadas de las descargas de audio: la de iTunes, en dos tamanos.

La ficha de iTunes trae una portada (`300x300bb.jpg`) y el CDN la reescala por
URL, asi que no hace falta una libreria de imagenes ni ffmpeg: se piden las
variantes de 200 px (la `thumb_key` de siempre, `<stem>.jpg`) y de 100 px (la de
las filas de 48 px, `<stem>.s.jpg`).

La URL llega en el body del cliente: lo que el backend baja se limita a la
lista de hosts de iTunes, sin redirecciones a otro lado. Todo es best effort:
una portada que no llega nunca tumba una descarga.
"""
from __future__ import annotations

import asyncio
import logging
import re
import uuid
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx

from .config import USER_AGENT

log = logging.getLogger("spitifo.covers")

COVER_PX = 200
SMALL_PX = 100
#: Timeout de cada bajada: es un extra, no puede colgar el job.
TIMEOUT_S = 5.0
#: Una portada de 200 px pesa ~14 KB: un cuerpo mucho mayor no es una portada.
MAX_BYTES = 1_500_000
MAX_HOPS = 2

_HOST = "mzstatic.com"
_SIZE_TAIL = re.compile(r"/\d+x\d+bb\.jpg$")


def _allowed(url: str) -> bool:
    """https, host de iTunes, sin usuario ni puerto raro, y sin query."""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return False
    if parts.scheme != "https" or parts.username or parts.password:
        return False
    if port not in (None, 443) or parts.query or parts.fragment:
        return False
    return host == _HOST or host.endswith("." + _HOST)


def itunes_cover_urls(url: str | None) -> tuple[str, str] | None:
    """`(url_200, url_100)` derivadas de la portada de la ficha, o None.

    Acepta solo `https` en un host de `mzstatic.com` y una ruta que termina en
    `/NxNbb.jpg`: cualquier otra cosa (otro host, `http`, `localhost`) se
    rechaza porque la URL la manda el cliente.
    """
    if not isinstance(url, str) or not url or not _allowed(url):
        return None
    if not _SIZE_TAIL.search(urlsplit(url).path):
        return None
    return (_SIZE_TAIL.sub(f"/{COVER_PX}x{COVER_PX}bb.jpg", url),
            _SIZE_TAIL.sub(f"/{SMALL_PX}x{SMALL_PX}bb.jpg", url))


async def _get(client: httpx.AsyncClient, url: str) -> bytes:
    """GET que solo sigue redirecciones que siguen dentro de la lista."""
    for _ in range(MAX_HOPS + 1):
        response = await client.get(url)
        if response.is_redirect:
            target = urljoin(url, response.headers.get("location", ""))
            if not _allowed(target):
                raise ValueError("redireccion fuera de iTunes")
            url = target
            continue
        response.raise_for_status()
        data = response.content
        if len(data) > MAX_BYTES or not data.startswith(b"\xff\xd8"):
            raise ValueError("la respuesta no es una portada jpg")
        return data
    raise ValueError("demasiadas redirecciones")


async def fetch_itunes_covers(artwork_url: str | None,
                              work: Path) -> tuple[Path, Path] | None:
    """Baja las dos portadas a `work`: `(grande, chica)`, o None si falla algo.

    Devuelve las dos o ninguna: una portada a medias dejaria a las filas con
    una imagen distinta de la del resto de las pantallas.
    """
    urls = itunes_cover_urls(artwork_url)
    if urls is None:
        return None
    try:
        timeout = httpx.Timeout(TIMEOUT_S)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False,
                                     headers={"User-Agent": USER_AGENT}) as c:
            big, small = await asyncio.gather(_get(c, urls[0]), _get(c, urls[1]))
    except Exception as e:
        log.warning("portada de iTunes no disponible (%s): %s", artwork_url, e)
        return None
    paths = []
    try:
        for data in (big, small):
            path = work / f".cover-{uuid.uuid4().hex[:8]}.jpg"
            path.write_bytes(data)
            paths.append(path)
    except OSError as e:
        log.warning("no se pudo escribir la portada: %s", e)
        return None
    return paths[0], paths[1]
