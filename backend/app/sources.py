"""Fuentes de busqueda y descarga. Cada clase es un adaptador a una API.

Reglas:
  search(q, limit) -> list[Track]   # siempre disponible
  resolve(track)   -> Track         # opcional: completa audio_url para descargar
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
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


_STOP_Q = {"the", "a", "an", "de", "la", "el", "y", "en", "of"}

# Palabras que delatan que un item de audio NO es musica (podcast, sermon,
# noticia, curso). Archive esta lleno de audio en general: sin esto, buscar
# "Numb Linkin Park" devuelve "HUBS report" y "Chaos in Portland".
NOT_MUSIC = {
    "podcast", "episode", "episodes", "news", "interview", "interviews",
    "sermon", "sermons", "lecture", "lectures", "prayer", "khutbah", "ustadz",
    "sheikh", "imam", "quran", "bible", "study", "class", "course", "lesson",
    "meeting", "minutes", "agenda", "report", "hearing", "testimony", "debate",
    "commentary", "briefing", "press", "conference", "panel", "discussion",
    "narrated", "narration", "story", "stories", "chapter", "audiobook",
    "book", "oracion", "iglesia", "church", "vlog", "trailer", "documentary",
    "documental", "tape", "tapes", "soundcheck", "rehearsal", "soundboard",
    "university", "college", "seminar", "symposium", "memorial", "funeral",
    "wedding", "speech", "eulogy", "homily", "recording", "field", "raw",
    "master", "radio", "radio", "programa", "program", "episode",
}

# palabras vacias: no ayudan a discriminar un resultado musical
FILLER = {
    "the", "a", "an", "and", "or", "but", "de", "la", "el", "los", "las", "un",
    "una", "y", "e", "o", "u", "en", "of", "to", "in", "for", "on", "with",
    "at", "from", "by", "is", "it", "as", "that", "this", "be", "are", "was",
    "were", "has", "have", "my", "me", "i", "you", "we", "they", "no", "not",
    "so", "if", "than", "then", "there", "here", "para", "por", "con", "sin",
    "que", "como", "part", "vol", "volume", "no", "number", "one", "two",
    "three", "version", "versions", "edit", "mix", "remaster", "remastered",
    "radio", "live", "feat", "featuring", "ft", "track", "song", "songs",
    "audio", "music", "musica", "música", "full", "album", "cd", "lp", "ep",
    "hq", "mp3", "flac", "wav", "320", "128", "192", "ape", "dvd", "video",
    "official", "complete", "new", "best", "top", "hit", "hits",
}


def _words(s: str) -> list[str]:
    return [w for w in re.findall(r"[\w']+", (s or "").lower()) if len(w) > 1]


def _distinctive(s: str) -> set[str]:
    return {w for w in _words(s) if w not in FILLER and w not in NOT_MUSIC}


def looks_like_music(title: str, artist: str = "") -> bool:
    """Falso si el titulo/artista tiene palabras de audio no musical."""
    return not (set(_words(f"{title} {artist}")) & NOT_MUSIC)


def relevance(query: str, title: str, artist: str = "") -> float:
    """0..1 exigiendo mayoria de palabras distintivas de la consulta.

    Buscar "Numb Linkin Park" (3 palabras) contra un item que solo dice
    "Park" (1 de 3) NO es lo que el usuario queria: se penaliza fuerte.
    """
    qd = _distinctive(query)
    if not qd:
        qd = set(_words(query))
    td = _distinctive(f"{title} {artist}")
    if not qd or not td:
        return 0.0
    hits = len(qd & td)
    coverage = hits / len(qd)
    if len(qd) > 1 and hits < max(2, len(qd) // 2 + 1):
        return coverage * 0.4
    return coverage


def _loose(q: str) -> str | None:
    """Query de respaldo: usa las palabras MAS largas (titulo/artista) con OR.

    archive exige AND entre palabras, asi que "linkin park numb" solo matchea
    items que digan las TRES palabras. Con OR sobre las dos palabras mas
    largas aparecen los items que digan "numb" y "linkin park".
    """
    words = [w.strip(" -_") for w in q.split() if w.strip()]
    words = [w for w in words if w.lower() not in _STOP_Q and len(w) > 1]
    if not words:
        return None
    # la palabra mas larga suele ser el titulo de la cancion
    words = sorted(words, key=len, reverse=True)[:3]
    joined = " OR ".join(f'"{w}"' for w in words)
    return f"({joined}) AND mediatype:(audio)"


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
            title = t.get("trackName", "")
            artist = t.get("artistName", "")
            # iTunes devuelve tambien hablados/intros de podcast en media=music
            if not looks_like_music(title, artist):
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
    # etree (conciertos en vivo) tiene solo ~4 items de audio: queda como extra.
    # audio_music y opensource_audio son donde vive el catalogo real (500k / 3M).
    COLLECTIONS = [
        "collection:(audio_music) AND mediatype:(audio)",
        "collection:(opensource_audio) AND mediatype:(audio)",
        "collection:(etree) AND mediatype:(audio)",
    ]
    AUDIO_EXT = (".mp3", ".flac", ".ogg", ".m4a", ".opus", ".wav")

    async def search(self, q: str, limit: int = 20) -> list[Track]:
        # archive matchea TODAS las palabras con AND: "linkin park numb" con
        # frase exacta da 0. Se prueban variantes de menor a mayor especificidad
        # y se corta en cuanto se juntan suficientes resultados.
        queries = [
            f'({q}) AND mediatype:(audio)',
            f'({q}) AND mediatype:(audio) AND collection:(audio_music)',
            f'({q}) AND mediatype:(audio) AND collection:(opensource_audio)',
            _loose(q),
        ]
        queries = [x for x in queries if x]

        out: list[Track] = []
        seen: set[str] = set()
        used_loose = False
        for i, query in enumerate(queries):
            if len(out) >= limit:
                break
            if i == len(queries) - 1 and query == _loose(q):
                used_loose = True  # el OR_relajado genera falsos positivos
            batch = await self._search_one(query, limit - len(out))
            for t in batch:
                if t.source_id in seen:
                    continue
                seen.add(t.source_id)
                t.extra["match_query"] = q
                out.append(t)
        # si hubo que recurrir al OR, descartar lo que no coincide en nada
        return self._rank(q, out, min_relevance=0.01 if used_loose else 0.0)[:limit]

    def _rank(self, query: str, tracks: list[Track],
              min_relevance: float = 0.0) -> list[Track]:
        """Ordena por relevancia REAL y descarta audio no-musical / irrelevante.

        El query relajado (OR) trae mucho ruido: "Numb Linkin Park" devolvia
        primero "HUBS report" y "Chaos in Portland". Se puntua con
        `relevance()` (exige mayoria de palabras distintivas) y se eliminan
        podcast/noticias/sermones con `looks_like_music()`.
        `min_relevance` descarta ademas lo que no coincide en nada (rel==0),
        que en el OR son falsos positivos por una sola palabra comun.
        """
        scored: list[tuple[float, Track]] = []
        for t in tracks:
            if not looks_like_music(t.title, t.artist):
                continue
            r = relevance(query, t.title, t.artist)
            if r <= min_relevance:
                continue
            scored.append((r, t))
        scored.sort(key=lambda x: -x[0])
        for r, t in scored:
            t.extra["relevance"] = round(r, 2)
        return [t for _, t in scored]

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
            raw_title = d.get("title") or ident
            # archive deja vacio el creator en muchos items (subidas de
            # soundcloud, ripping de mp3). Si el titulo trae "Artista - Cancion"
            # se puede sacar de ahi para no dejar el nombre como "desconocido".
            title = raw_title
            artist = creator
            if not artist:
                m = re.match(r"^([^-]{2,40})\s+-\s+(.+)$", raw_title)
                if m:
                    artist = m.group(1).strip()
                    title = m.group(2).strip()
                else:
                    # el identificador suele ser junk ("yt-1s", "numb_dev"):
                    # no ponerlo como nombre de artista
                    artist = "varios"
            # Los items de etree guardan UN item por pista pero todos comparten el
            # mismo `title` (que es el nombre del concierto). Ese titulo es lo que
            # hay que usar para agrupar: el campo `show` no existe en estos items.
            show = d.get("show") or d.get("event") or d.get("venue")
            if isinstance(show, list):
                show = ", ".join(show)
            if not show:
                show = raw_title  # fallback: el titulo original ES el show
            out.append(Track(
                source=self.name,
                source_id=ident,
                title=title,
                artist=artist,
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
            title = title.rsplit(".", 1)[0]
            # Wikimedia tiene mucho audio hablado (LL-Q... = pronunciacion de
            # una palabra de wikipedia), no musica. Solo pasar lo que es musical.
            if not looks_like_music(title, "Wikimedia Commons"):
                continue
            out.append(Track(
                source=self.name,
                source_id=str(p.get("pageid")),
                title=title,
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
