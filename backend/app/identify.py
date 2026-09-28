"""Identidad real de un archivo de audio: lee tags sin bajar el archivo entero.

Internet Archive guarda cada pista de un concierto como un item aparte, pero el
nombre del archivo (`ph2022-12-31_s3t04.mp3`) NO dice que cancion es. La unica
fuente de verdad son los tags internos del audio, asi que hay que leerlos.
"""
from __future__ import annotations

import asyncio
import io
import logging
import re
from typing import Any

import httpx

from .sources import UA

log = logging.getLogger("spitifo.identify")

# se leen solo los primeros KB: alcanza para los tags ID3 sin bajar 40MB
HEAD_BYTES = 262_144
TIMEOUT = httpx.Timeout(25.0, connect=10.0)


def _clean(s: str | None) -> str | None:
    if not s:
        return None
    s = str(s).strip()
    return s or None


def parse_id3(data: bytes) -> dict[str, Any]:
    """Lee tags ID3v2 del inicio del archivo sin descargarlo entero."""
    out: dict[str, Any] = {}
    try:
        from mutagen.id3 import ID3, ID3NoHeaderError
        id3 = ID3(io.BytesIO(data))
    except (ID3NoHeaderError, Exception):  # noqa: B014 - id3 puede tirar varias
        id3 = None
    if id3 is None:
        return out
    mapping = {
        "TIT2": "title", "TPE1": "artist", "TPE2": "album",
        "TALB": "album", "TDRC": "year", "TCON": "genre", "TRCK": "track",
    }
    for tag, key in mapping.items():
        if tag in id3:
            val = id3[tag].text
            if isinstance(val, list):
                val = val[0] if val else None
            out[key] = _clean(str(val)) if val is not None else None
    if "COMM" in id3:  # comentario = nota de la persona que subio el archivo
        try:
            c = id3["COMM"]
            out["comment"] = _clean(str(c.text[0])) if c.text else None
        except Exception:
            pass
    return {k: v for k, v in out.items() if v}


def _derive_from_name(fname: str) -> dict[str, Any]:
    """Ultimo recurso: sacar algo del nombre del archivo."""
    stem = re.sub(r"\.[a-z0-9]{2,4}$", "", fname, flags=re.I)
    # quita prefijos de fecha/venue: ph2022-12-31_s3t04 -> ""
    stem = re.sub(r"^[a-z]{0,4}\d{4}-\d{2}-\d{2}[_-]s\d+t\d+", "", stem, flags=re.I)
    stem = stem.strip("_- ")
    return {"title": stem or None} if stem else {}


async def identify(url: str, fname: str) -> dict[str, Any]:
    """Devuelve los tags reales del audio en `url` (id3/flac/mp4)."""
    try:
        timeout = TIMEOUT
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True,
                                     headers={"User-Agent": UA}) as c:
            async with c.stream("GET", url) as r:
                r.raise_for_status()
                buf = bytearray()
                async for chunk in r.aiter_bytes(32768):
                    buf.extend(chunk)
                    if len(buf) >= HEAD_BYTES:
                        break
        data = bytes(buf)
    except Exception as e:
        log.warning("no se pudo leer %s: %s", fname, e)
        return {"_error": str(e)}

    data = data + b"\x00" * (HEAD_BYTES - len(data))
    low = fname.lower()
    info: dict[str, Any] = {}

    try:
        if low.endswith(".flac") or data[:4] == b"fLaC":
            from mutagen.flac import FLAC
            f = FLAC(io.BytesIO(data))
            for k in ("title", "artist", "album", "date", "genre"):
                if k in f:
                    info[k] = _clean(str(f[k][0])) if isinstance(f[k], list) else _clean(str(f[k]))
        elif low.endswith((".m4a", ".mp4")):
            from mutagen.mp4 import MP4
            f = MP4(io.BytesIO(data))
            mp4map = {"\xa9nam": "title", "\xa9ART": "artist",
                      "\xa9alb": "album", "\xa9day": "year", "\xa9gen": "genre"}
            for k, name in mp4map.items():
                if k in f:
                    val = f[k]
                    if isinstance(val, list):
                        val = val[0] if val else None
                    info[name] = _clean(str(val)) if val else None
        else:
            info = parse_id3(data)
    except Exception:
        # ID3 suele estar mas alla del buffer (flac con offset, etc)
        pass

    info = {k: v for k, v in info.items() if v}
    if not info.get("title"):
        derived = _derive_from_name(fname)
        if derived:
            info["title"] = derived["title"]
            info["_source"] = "derived"
        else:
            info["_source"] = "none"
    else:
        info["_source"] = "tags"
    return info


async def identify_with_item(url: str, fname: str,
                             item_meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """Tags del audio +, si el archivo no los trae, el titulo del item de archive.

    Muchos items de internet archive (subidas de soundcloud) tienen el mp3 sin
    tags: ahi el unico titulo util es el `title` del item, que la gente si
    carga. Se marca `_source` para que la UI sepa de donde salio el nombre.
    Un titulo "derived" (saco del nombre del archivo) NO cuenta como leido:
    para esos casos el titulo del item es mucho mejor.
    """
    info = await identify(url, fname)
    if info.get("_source") in ("derived", "none") and item_meta:
        t = _clean(item_meta.get("title"))
        c = item_meta.get("creator")
        if isinstance(c, list):
            c = ", ".join(c)
        if t:
            info["title"] = t
            info["_source"] = "item-title"
            if not info.get("artist") and c:
                info["artist"] = _clean(str(c))
    return info


# ---------------------------------------------------------------- comparacion
_STOP = {"the", "a", "an", "and", "or", "feat", "featuring", "live",
         "version", "remaster", "radio", "edit", "mix", "mono", "stereo"}


def norm(s: str | None) -> str:
    if not s:
        return ""
    s = re.sub(r"[^a-z0-9 ]", " ", s.lower())
    words = [w for w in s.split() if w and w not in _STOP]
    return " ".join(words)


def similarity(a: str | None, b: str | None) -> float:
    """Similitud 0..1 entre dos titulos por solapamiento de palabras."""
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    wa, wb = set(na.split()), set(nb.split())
    if not wa or not wb:
        return 0.0
    inter = len(wa & wb)
    return inter / min(len(wa), len(wb))


def verdict(query: str, real_title: str | None) -> tuple[str, str]:
    """(estado, etiqueta) para mostrar en la UI segun cuanto coincide."""
    if not real_title:
        return "unknown", "no se pudo identificar"
    s = similarity(query, real_title)
    if s >= 0.8:
        return "match", "coincide"
    if s >= 0.4:
        return "partial", "parecido"
    return "mismatch", "NO es lo que buscabas"
