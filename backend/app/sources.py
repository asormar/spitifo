"""Fuentes de busqueda y descarga. Cada clase es un adaptador a una API.

Reglas:
  search(q, limit) -> list[Track]   # siempre disponible
  resolve(track)   -> Track         # opcional: completa audio_url para descargar
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx

from .models import Track

log = logging.getLogger("spitifo.sources")
UA = "spitifo/0.1 (+https://github.com/asormar/spitifo)"
TIMEOUT = httpx.Timeout(20.0, connect=10.0)


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True,
                             headers={"User-Agent": UA},
                             limits=httpx.Limits(max_connections=16))


class Source:
    name = "base"
    # requiere credencial para funcionar (se chequea en /api/health)
    needs_key: str | None = None

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = _client()
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def available(self) -> bool:
        if self.needs_key and not os.getenv(self.needs_key):
            return False
        return True

    async def search(self, q: str, limit: int = 20) -> list[Track]:
        raise NotImplementedError

    async def resolve(self, track: Track) -> Track:
        return track


# --------------------------------------------------------------------------
# iTunes Search API — catalogo enorme, pero SOLO preview de 30s.
# Sirve para que el usuario encuentre el tema y vea de donde viene.
# --------------------------------------------------------------------------
class ITunesSource(Source):
    name = "itunes"

    async def search(self, q: str, limit: int = 20) -> list[Track]:
        r = await self.client.get(
            "https://itunes.apple.com/search",
            params={"term": q, "media": "music", "limit": limit})
        r.raise_for_status()
        out = []
        for t in r.json().get("results", []):
            if t.get("kind") != "song":
                continue
            out.append(Track(
                source=self.name,
                source_id=str(t["trackId"]),
                title=t.get("trackName", ""),
                artist=t.get("artistName", ""),
                album=t.get("collectionName"),
                duration_s=(t.get("trackTimeMillis", 0) // 1000) or None,
                artwork_url=(t.get("artworkUrl100") or "").replace("100x100", "300x300") or None,
                preview_url=t.get("previewUrl"),
                year=(t.get("releaseDate") or "")[:4] or None,
                extra={"genre": t.get("primaryGenreName")},
            ))
        return out


# --------------------------------------------------------------------------
# Internet Archive — descargas reales completas. `collection:(etree)` es
# la coleccion de conciertos en vivo con FLAC/MP3 de calidad.
# --------------------------------------------------------------------------
class InternetArchiveSource(Source):
    name = "archive"
    COLLECTIONS = [
        "collection:(etree) AND mediatype:(audio)",
        "collection:(audio_music) AND mediatype:(audio)",
        "collection:(78rpm) AND mediatype:(audio)",
    ]
    AUDIO_EXT = (".mp3", ".flac", ".ogg", ".m4a", ".opus", ".wav")

    async def search(self, q: str, limit: int = 20) -> list[Track]:
        per = max(4, limit // len(self.COLLECTIONS))
        tasks = [self._search_one(f"({q}) AND {c}", per) for c in self.COLLECTIONS]
        batches = await asyncio.gather(*tasks, return_exceptions=True)

        seen: set[str] = set()
        out: list[Track] = []
        for b in batches:
            if isinstance(b, Exception):
                log.warning("archive subsearch fallo: %s", b)
                continue
            for t in b:
                if t.source_id in seen:
                    continue
                seen.add(t.source_id)
                out.append(t)
        return out[:limit]

    async def _search_one(self, q: str, limit: int) -> list[Track]:
        params = [
            ("q", q), ("fl[]", "identifier"), ("fl[]", "title"),
            ("fl[]", "creator"), ("fl[]", "year"), ("rows", limit),
            ("output", "json"),
        ]
        r = await self.client.get(
            "https://archive.org/advancedsearch.php", params=params)
        r.raise_for_status()
        out = []
        for d in r.json()["response"]["docs"]:
            ident = d.get("identifier")
            if not ident:
                continue
            creator = d.get("creator")
            creator = ", ".join(creator) if isinstance(creator, list) else (creator or "")
            # Los items de etree guardan UN item por pista pero todos comparten el
            # mismo `title` (que es el nombre del concierto). Ese titulo es lo que
            # hay que usar para agrupar: el campo `show` no existe en estos items.
            show = d.get("show") or d.get("event") or d.get("venue")
            if isinstance(show, list):
                show = ", ".join(show)
            title = d.get("title") or ident
            if not show:
                show = title  # fallback: el titulo ES el show
            out.append(Track(
                source=self.name,
                source_id=ident,
                title=title,
                artist=creator or "desconocido",
                year=str(d["year"]) if d.get("year") else None,
                extra={
                    "collection": "Internet Archive",
                    "needs_resolve": True,
                    "show": show,
                    "item_url": f"https://archive.org/details/{ident}",
                },
            ))
        return out

    async def resolve(self, track: Track, query: str | None = None) -> Track:
        """Elige el archivo que REALMENTE corresponde a la consulta.

        Antes elegia el primer mp3 por extension/tamano, que podia ser una pista
        distinta de la que se pidio. Ahora:
          1. agrupa los archivos de audio (mp3+flac del mismo take)
          2. lee los tags de cada grupo (identify.identify_with_item)
          3. puntua contra la consulta y devuelve el mejor
        """
        from .identify import identify_with_item, similarity, verdict

        r = await self.client.get(f"https://archive.org/metadata/{track.source_id}")
        r.raise_for_status()
        data = r.json()
        files = data.get("files", [])
        server = data.get("server", "archive.org")
        d1 = data.get("dir", "")
        meta = data.get("metadata", {})

        def _url(fname: str) -> str:
            from urllib.parse import quote
            return f"https://{server}{d1}/{quote(fname)}"

        def _rank_ext(ext: str) -> int:
            return {".mp3": 0, ".m4a": 1, ".opus": 2, ".ogg": 2, ".flac": 4}.get(ext, 3)

        # 1) agrupa por "track logico": quita extension y sufijos sXtNN
        import re
        groups: dict[str, list[dict]] = {}
        for f in files:
            name = f.get("name", "")
            low = name.lower()
            if not low.endswith(self.AUDIO_EXT) or low.endswith((".xml", ".meta.xml")):
                continue
            base = re.sub(r"\.[a-z0-9]{2,4}$", "", name, flags=re.I)
            groups.setdefault(base, []).append(f)

        if not groups:
            raise LookupError(f"{track.source_id}: sin archivos de audio")

        # 2) puntua cada grupo (top 6 candidatos, el resto solo por nombre)
        cands = sorted(
            groups.items(),
            key=lambda kv: (min(_rank_ext(f["name"][f["name"].rfind("."):].lower())
                                 for f in kv[1]),
                            sum(int(f.get("size") or 0) for f in kv[1])),
        )[:6]

        scored = []
        for base, gfiles in cands:
            best_file = min(
                gfiles,
                key=lambda f: (_rank_ext("." + f["name"].rsplit(".", 1)[-1].lower()),
                               -int(f.get("size") or 0)))
            url = _url(best_file["name"])
            info = await identify_with_item(
                url, best_file["name"], meta if track.source_id else None)
            real_title = info.get("title")
            sim = similarity(query, real_title) if query else 0.0
            if not query:
                # sin consulta: prioriza el nombre del archivo que se parezca al titulo del item
                sim = similarity(track.title, real_title)
            scored.append((sim, best_file, url, info, base))

        scored.sort(key=lambda t: -t[0])
        sim, best_file, url, info, base = scored[0]

        track.audio_url = url
        track.extra["format"] = best_file["name"].rsplit(".", 1)[-1].upper()
        track.extra["size_mb"] = round(int(best_file.get("size") or 0) / 1_048_576, 1)
        track.extra["filename"] = best_file["name"]
        track.extra["item_url"] = f"https://archive.org/details/{track.source_id}"
        track.extra["uploader"] = meta.get("uploader")
        track.extra["license_url"] = meta.get("licenseurl")
        track.license = meta.get("licenseurl") or meta.get("rights") or "sin licencia declarada en el item"

        # duracion del archivo elegido
        dur = best_file.get("length")
        if dur:
            try:
                track.duration_s = int(float(dur))
            except (TypeError, ValueError):
                pass

        # identidad real vs lo pedido
        real_title = info.get("title")
        if real_title:
            state, label = verdict(query or track.title, real_title)
            track.extra["real_title"] = real_title
            track.extra["real_artist"] = info.get("artist")
            track.extra["real_album"] = info.get("album")
            track.extra["match"] = state
            track.extra["match_label"] = label
            track.extra["match_score"] = round(sim, 2)
            track.extra["title_source"] = info.get("_source", "tags")
        # si el archivo no tiene nada utilizable, avisarlo explicitamente
        if info.get("_source") in ("derived", "none"):
            track.extra["match"] = "unknown"
            track.extra["match_label"] = "no se pudo verificar (el archivo no trae tags)"
        track.album = track.album or info.get("album") or track.title
        return track


# --------------------------------------------------------------------------
# Jamendo — musica indie CC con MP3 completo. Requiere client_id gratis.
# --------------------------------------------------------------------------
class JamendoSource(Source):
    name = "jamendo"
    needs_key = "JAMENDO_CLIENT_ID"

    async def search(self, q: str, limit: int = 20) -> list[Track]:
        r = await self.client.get("https://api.jamendo.com/v3.0/tracks/", params={
            "client_id": os.getenv(self.needs_key, ""),
            "format": "json", "limit": limit, "search": q,
            "groupby": "artist_id", "include": "musicinfo+licenses",
        })
        if r.status_code == 401 or "Invalid Client" in r.text:
            raise RuntimeError("Jamendo: client_id invalido o ausente")
        r.raise_for_status()
        out = []
        for t in r.json().get("results", []):
            if t.get("audio_download_allowed") not in (True, "1", 1):
                continue  # solo lo descargable
            out.append(Track(
                source=self.name,
                source_id=t["id"],
                title=t.get("name", ""),
                artist=t.get("artist_name", ""),
                album=t.get("album_name"),
                duration_s=t.get("duration"),
                artwork_url=t.get("album_image") or t.get("image"),
                audio_url=t.get("audio_url"),
                license=(t.get("license_ccurl") or "CC"),
                extra={"shareurl": t.get("shareurl")},
            ))
        return out


# --------------------------------------------------------------------------
# Wikimedia Commons — audio libre (wav/ogg), util para sonidos y dominio publico.
# --------------------------------------------------------------------------
class WikimediaSource(Source):
    name = "wikimedia"

    async def search(self, q: str, limit: int = 20) -> list[Track]:
        r = await self.client.get("https://commons.wikimedia.org/w/api.php", params={
            "action": "query", "format": "json", "generator": "search",
            "gsrsearch": f"filetype:audio {q}", "gsrnamespace": "6",
            "gsrlimit": limit, "prop": "imageinfo", "iiprop": "url|mime|size|extmetadata",
        })
        r.raise_for_status()
        out = []
        for p in r.json().get("query", {}).get("pages", {}).values():
            ii = (p.get("imageinfo") or [{}])[0]
            url = ii.get("url")
            if not url:
                continue
            title = p.get("title", "").removeprefix("File:")
            out.append(Track(
                source=self.name,
                source_id=str(p.get("pageid")),
                title=title.rsplit(".", 1)[0],
                artist="Wikimedia Commons",
                artwork_url=None,
                audio_url=url,
                license="CC / dominio publico",
                extra={"format": (ii.get("mime") or "").split("/")[-1],
                       "size_mb": round(int(ii.get("size") or 0) / 1_048_576, 1)},
            ))
        return out


# --------------------------------------------------------------------------
# yt-dlp — fuente EXTRA opcional, apagada por defecto. Contra ToS de las
# plataformas; se activa solo si YTDLP_ENABLED=1.
# --------------------------------------------------------------------------
class YtDlpSource(Source):
    name = "ytdlp"

    def available(self) -> bool:
        return os.getenv("YTDLP_ENABLED", "0") == "1"

    async def search(self, q: str, limit: int = 20) -> list[Track]:
        if not self.available():
            return []
        import yt_dlp
        opts = {
            "quiet": True, "no_warnings": True, "extract_flat": "in_playlist",
            "skip_download": True, "default_search": f"ytsearch{limit}",
        }
        loop = asyncio.get_running_loop()

        def _run():
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(f"ytsearch{limit}:{q}", download=False)

        data = await loop.run_in_executor(None, _run)
        out = []
        for e in (data or {}).get("entries", []) or []:
            if not e:
                continue
            out.append(Track(
                source=self.name,
                source_id=e["id"],
                title=e.get("title") or "",
                artist=e.get("uploader") or e.get("channel") or "",
                duration_s=e.get("duration"),
                artwork_url=None,
                # resolver a URL de audio en la descarga
                extra={"webpage_url": e.get("webpage_url")},
                license="ToS de la plataforma (uso personal)",
            ))
        return out


# --------------------------------------------------------------------------
# Registro
# --------------------------------------------------------------------------
ALL_SOURCES: list[Source] = [
    ITunesSource(),
    InternetArchiveSource(),
    JamendoSource(),
    WikimediaSource(),
    YtDlpSource(),
]

BY_NAME = {s.name: s for s in ALL_SOURCES}


async def search_all(q: str, limit: int = 20,
                     sources: list[str] | None = None) -> list[Track]:
    """Busca en paralelo en las fuentes pedidas (todas disponibles por default)."""
    chosen = [BY_NAME[n] for n in sources] if sources else list(ALL_SOURCES)
    chosen = [s for s in chosen if s.available()]
    results = await asyncio.gather(
        *(s.search(q, limit) for s in chosen), return_exceptions=True)
    out: list[Track] = []
    for src, r in zip(chosen, results):
        if isinstance(r, Exception):
            log.warning("fuente %s fallo: %s", src.name, r)
            continue
        out.extend(r)
    return out
