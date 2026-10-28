"""Ficha de cada artista: generos y artistas similares (ADR 0003, 2 y 3).

La biblioteca del usuario dice QUE artistas escucha; MusicBrainz dice de que
genero son y ListenBrainz Labs, a quien se parecen. El resultado se guarda por
dispositivo, igual que el historial de escucha:

    artistinfo-<device>.json    {"version": 1, "artists": {<folded>: {...}}}

Cada dispositivo escribe SOLO su archivo y la vista se arma mergeando todos
(gana el `fetched_at` mas nuevo por artista). Este modulo es la parte pura
(nombres, records, merge y score), los clientes HTTP con su throttle, y un
`Enricher` que completa lo que falta en un hilo de fondo.

El throttle de MusicBrainz es de 1.1 s entre requests EN TODO EL PROCESO,
como pide su rate limit; el de ListenBrainz, 0.5 s. Los dos aceptan un reloj y
un `sleep` inyectables para los tests.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
import unicodedata
from dataclasses import dataclass, field

import httpx

from .config import USER_AGENT

log = logging.getLogger(__name__)

#: Version del formato. Un major distinto se rechaza en vez de adivinar.
VERSION = 1

ARTISTINFO_PREFIX = "artistinfo-"
_ARTISTINFO_FILE_RE = re.compile(
    r"^" + re.escape(ARTISTINFO_PREFIX) + r"(?P<dev>.+)\.json$")

STATUSES = frozenset({"ok", "unknown", "error"})

#: Una pista de mas de 20 minutos es un podcast o un programa de radio: si
#: TODAS las pistas de un artista lo son, no se busca (Late Motiv, por ejemplo).
MAX_TRACK_SECONDS = 20 * 60

MAX_GENRES = 8
MAX_SIMILAR = 30

SEARCH_LIMIT = 5
#: Un candidato con el nombre plegado igual al buscado entra desde 90.
EXACT_SCORE = 90

MB_BASE = "https://musicbrainz.org/ws/2"
MB_INTERVAL = 1.1
LB_URL = "https://labs.api.listenbrainz.org/similar-artists/json"
LB_INTERVAL = 0.5
SIMILAR_ALGORITHM = (
    "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100"
    "_filter_True_skip_30")

#: Un `ok`/`unknown` se refresca a los 30 dias; un `error`, al dia siguiente.
STALE_OK_SECONDS = 30 * 86400
#: Version de la regla que eligio al artista en MusicBrainz. Subirla vuelve
#: vencidas las fichas viejas: la regla 1 aceptaba un candidato parecido y
#: confundio un programa de radio con un artista de drum and bass.
MATCH_RULE = 2
STALE_ERROR_SECONDS = 86400

#: El enricher guarda cada 5 fichas y no bloquea nunca una request.
ENRICH_BATCH = 5
ENRICH_TOP_CANDIDATES = 12
MAX_CONSECUTIVE_ERRORS = 3
OFFLINE_COOLDOWN = 60.0
#: Tras una corrida completa no se vuelve a arrancar hasta pasado este tiempo.
#: Sin esto cada GET de Discover relanzaba el hilo, releia la nube y respondia
#: `running: true`, asi que la vista nunca dejaba de consultar.
RERUN_AFTER = 600.0


class ArtistInfoFormatError(ValueError):
    """El `artistinfo-*` remoto no tiene el formato que se entiende."""


# ------------------------------------------------------------------- nombres
def fold(name: str) -> str:
    """Clave de matching: sin acentos, en minusculas y con espacios colapsados."""
    if not isinstance(name, str):
        return ""
    text = unicodedata.normalize("NFKD", name)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return " ".join(text.casefold().split())


#: Separadores de colaboraciones. Los que son palabras (con, feat, featuring,
#: ft, vs, x, y) exigen limite de palabra y no distinguen mayusculas; `&` y `,`
#: son simbolos. Se parten con los espacios de alrededor.
_COLLAB_RE = re.compile(
    r"\s*(?:&|,)\s*"
    r"|\s+\b(?:feat|ft|featuring|con|vs|y|x)\b\.?\s+",
    re.IGNORECASE)


def artist_name(entry: dict) -> str:
    """Artista de una entrada de la biblioteca.

    Manda la etiqueta `artist`; si falta, el primer segmento de la clave
    (`Artista/Artista - Titulo.mp3`); si tampoco hay carpeta, la parte anterior
    a `" - "` del nombre del archivo. Ultimo recurso: el nombre sin extension.
    """
    if not isinstance(entry, dict):
        return ""
    tag = entry.get("artist")
    if isinstance(tag, str) and tag.strip():
        return tag.strip()
    key = entry.get("key")
    if not isinstance(key, str) or not key:
        return ""
    if "/" in key:
        first = key.split("/", 1)[0]
        if first:
            return first
    name = key.rsplit("/", 1)[-1]
    if " - " in name:
        return name.split(" - ", 1)[0]
    dot = name.rfind(".")
    return name[:dot] if dot > 0 else name


def split_artists(name: str) -> list[str]:
    """Partes de un credito de colaboracion: `"A & B"` -> `["A", "B"]`.

    Solo se parte cuando TODAS las partes quedan de 2 caracteres o mas: asi
    `"Malcolm X"` no se rompe por un lado de una letra. Devuelve `[name]`
    cuando no hay separador o cuando partir dejaria una parte demasiado corta.
    Las partes repetidas se descartan.
    """
    if not isinstance(name, str):
        return []
    text = name.strip()
    if not text:
        return []
    parts = [part.strip() for part in _COLLAB_RE.split(text) if part.strip()]
    if len(parts) < 2 or any(len(part) < 2 for part in parts):
        return [text]
    unique: list[str] = []
    seen: set[str] = set()
    for part in parts:
        folded = fold(part)
        if folded in seen:
            continue
        seen.add(folded)
        unique.append(part)
    return unique


def _is_long_track(duration: object, max_track_seconds: float) -> bool | None:
    """True si la pista es larga, False si es corta, None si no se sabe."""
    if isinstance(duration, bool) or not isinstance(duration, (int, float)):
        return None
    return float(duration) > max_track_seconds


def library_artists(entries: list[dict], *,
                    max_track_seconds: float = MAX_TRACK_SECONDS) -> dict:
    """`{folded: {name, tracks}}` con los artistas que vale la pena buscar.

    Un credito de colaboracion (`"A & B"`, `"A feat. B"`) se parte y cada parte
    suma la pista. Salta los videos y los artistas cuyas pistas conocidas son
    TODAS largas (podcasts y programas de radio). Una duracion desconocida no
    cuenta como larga NI como corta: no descarta al artista por si sola ni
    salva a un podcast cuyas pistas conocidas son todas largas.
    """
    groups: dict[str, dict] = {}
    for entry in entries or ():
        if not isinstance(entry, dict) or entry.get("kind") == "video":
            continue
        long_track = _is_long_track(entry.get("duration_s"), max_track_seconds)
        for name in split_artists(artist_name(entry)):
            folded = fold(name)
            if not folded:
                continue
            group = groups.setdefault(folded, {"name": name, "tracks": 0,
                                               "long": 0, "short": 0})
            group["tracks"] += 1
            if long_track is True:
                group["long"] += 1
            elif long_track is False:
                group["short"] += 1
    return {folded: {"name": group["name"], "tracks": group["tracks"]}
            for folded, group in groups.items()
            if not (group["long"] and not group["short"])}


# -------------------------------------------------------------------- records
def _number(value: object) -> float | None:
    """Numero de verdad: `bool` es subclase de `int` y no es un numero."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _clean_genres(raw: object) -> list[list]:
    """`[[name, count], ...]` valido, ordenado y acotado a `MAX_GENRES`."""
    pairs: list[tuple[str, int]] = []
    if isinstance(raw, list):
        for item in raw:
            # MusicBrainz devuelve objetos {name, count}; el storage, pares.
            if isinstance(item, dict):
                name, count = item.get("name"), _number(item.get("count"))
            elif isinstance(item, (list, tuple)) and len(item) >= 2:
                name, count = item[0], _number(item[1])
            else:
                continue
            if not isinstance(name, str) or not name.strip():
                continue
            if count is None or count <= 0:
                continue
            pairs.append((name.strip(), int(count)))
    pairs.sort(key=lambda pair: (-pair[1], pair[0]))
    return [[name, count] for name, count in pairs[:MAX_GENRES]]


def _clean_similar(raw: object) -> list[dict]:
    """`[{name, mbid, score}, ...]` valido, ordenado y acotado."""
    out: list[dict] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            mbid = item.get("mbid")
            score = _number(item.get("score"))
            if not isinstance(name, str) or not name.strip():
                continue
            if not isinstance(mbid, str) or not mbid:
                continue
            out.append({"name": name.strip(), "mbid": mbid,
                        "score": max(0.0, score if score is not None else 0.0)})
    out.sort(key=lambda c: (-c["score"], c["name"]))
    return out[:MAX_SIMILAR]


def _record_from_storage(raw: object) -> dict | None:
    """Registro leido de un archivo. None si le falta algo o viene mal."""
    if not isinstance(raw, dict):
        return None
    name = raw.get("name")
    status = raw.get("status")
    fetched = _number(raw.get("fetched_at"))
    if not isinstance(name, str) or not name.strip():
        return None
    if status not in STATUSES or fetched is None or fetched < 0:
        return None
    mbid = raw.get("mbid")
    return {
        "name": name.strip(),
        "mbid": mbid if isinstance(mbid, str) and mbid else None,
        "genres": _clean_genres(raw.get("genres")),
        "similar": _clean_similar(raw.get("similar")),
        "fetched_at": fetched,
        "status": status,
        "rule": int(_number(raw.get("rule")) or 1),
    }


def unknown_record(name: str, when: float) -> dict:
    """MusicBrainz no conoce al artista: no se reintenta por 30 dias."""
    return {"name": name, "mbid": None, "genres": [], "similar": [],
            "fetched_at": when, "status": "unknown", "rule": MATCH_RULE}


def error_record(name: str, when: float,
                 previous: dict | None = None) -> dict:
    """La consulta fallo: se conserva lo que ya se sabia y se reintenta manana."""
    base = previous if isinstance(previous, dict) else {}
    # Lo de una regla vieja no se conserva: podria ser el artista equivocado.
    if base.get("rule", 1) != MATCH_RULE:
        base = {}
    return {"name": base.get("name") or name,
            "mbid": base.get("mbid"),
            "genres": _clean_genres(base.get("genres")),
            "similar": _clean_similar(base.get("similar")),
            "fetched_at": when, "status": "error", "rule": MATCH_RULE}


def is_stale(record: object, now: float) -> bool:
    """True si la ficha falta o vencio (30 dias ok/unknown, 1 dia error)."""
    if not isinstance(record, dict):
        return True
    status = record.get("status")
    if status not in STATUSES:
        return True
    fetched = _number(record.get("fetched_at"))
    if fetched is None or record.get("rule", 1) != MATCH_RULE:
        return True
    limit = STALE_ERROR_SECONDS if status == "error" else STALE_OK_SECONDS
    return now - fetched > limit


def artistinfo_file(device: str) -> str:
    return f"{ARTISTINFO_PREFIX}{device}.json"


def parse_artistinfo_file(name: str) -> str | None:
    """Device id desde `artistinfo-<dev>.json`, o None."""
    found = _ARTISTINFO_FILE_RE.match(name)
    return found.group("dev") if found else None


# ------------------------------------------------------------------- serializacion
@dataclass
class ArtistInfoBook:
    """Fichas de UN dispositivo. El merge gana por `fetched_at`."""

    artists: dict[str, dict] = field(default_factory=dict)
    version: int = VERSION

    def to_bytes(self) -> bytes:
        payload = {"version": self.version,
                   "artists": {key: self.artists[key]
                               for key in sorted(self.artists)}}
        return json.dumps(payload, sort_keys=True,
                          ensure_ascii=False).encode("utf-8")

    @classmethod
    def from_bytes(cls, data: bytes) -> "ArtistInfoBook":
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ArtistInfoFormatError("artistinfo no es JSON valido") from exc
        if not isinstance(payload, dict):
            raise ArtistInfoFormatError("artistinfo no es un objeto JSON")
        if payload.get("version") != VERSION:
            raise ArtistInfoFormatError(
                f"version de artistinfo desconocida: {payload.get('version')!r}")
        artists = payload.get("artists")
        if not isinstance(artists, dict):
            raise ArtistInfoFormatError("artistinfo no trae artists")
        clean = {}
        for key, raw in artists.items():
            record = _record_from_storage(raw)
            if isinstance(key, str) and key and record:
                clean[key] = record
        return cls(artists=clean)

    def merged(self, other: "ArtistInfoBook") -> "ArtistInfoBook":
        """Merge de dos dispositivos: el `fetched_at` mas nuevo gana."""
        out = dict(self.artists)
        for key, record in other.artists.items():
            old = out.get(key)
            if old is None or record.get("fetched_at", 0) > old.get(
                    "fetched_at", 0):
                out[key] = record
        return ArtistInfoBook(artists=out)


# -------------------------------------------------------------------- throttle
class Throttle:
    """Espacia requests a una API entre TODO el proceso.

    El reloj y el `sleep` se inyectan: los tests comprueban las esperas sin
    dormir de verdad. `wait()` devuelve lo que espero (0 en la primera).
    """

    def __init__(self, interval: float, *, clock=time.monotonic,
                 sleep=time.sleep) -> None:
        self.interval = float(interval)
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> float:
        with self._lock:
            now = self._clock()
            delay = max(0.0, self._next - now)
            if delay > 0:
                self._sleep(delay)
                now = self._clock()
            self._next = now + self.interval
            return delay


#: Throttles compartidos por todas las instancias (el rate limit es del proceso).
MB_THROTTLE = Throttle(MB_INTERVAL)
LB_THROTTLE = Throttle(LB_INTERVAL)


def _http_client() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(20.0, connect=10.0),
                        headers={"User-Agent": USER_AGENT},
                        follow_redirects=True)


def _candidate_names(candidate: dict) -> set[str]:
    """Nombres plegados con los que MusicBrainz identifica al candidato.

    Ademas de `name` se miran `sort-name` y los `aliases`, que es donde
    MusicBrainz guarda el nombre real de un artista cuando el titulo de la
    busqueda coincide con otra cosa ("Late Motiv" el programa contra "Late
    Motiv" la banda).
    """
    names: set[str] = set()
    for key in ("name", "sort-name"):
        value = candidate.get(key)
        if isinstance(value, str):
            folded = fold(value)
            if folded:
                names.add(folded)
    aliases = candidate.get("aliases")
    if isinstance(aliases, list):
        for alias in aliases:
            if not isinstance(alias, dict):
                continue
            for key in ("name", "sort-name"):
                value = alias.get(key)
                if isinstance(value, str):
                    folded = fold(value)
                    if folded:
                        names.add(folded)
    return names


class MusicBrainz:
    """Busqueda de artistas y sus generos (decision 2 del ADR)."""

    def __init__(self, client: httpx.Client | None = None, *,
                 throttle: Throttle | None = None) -> None:
        self._client = client
        self._throttle = throttle if throttle is not None else MB_THROTTLE

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = _http_client()
        return self._client

    def _get(self, path: str, params: dict) -> dict:
        self._throttle.wait()
        resp = self.client.get(f"{MB_BASE}/{path}",
                               params={"fmt": "json", **params})
        resp.raise_for_status()
        payload = resp.json()
        if not isinstance(payload, dict):
            raise ValueError("MusicBrainz no devolvio un objeto")
        return payload

    def search(self, name: str) -> list[dict]:
        payload = self._get("artist",
                            {"query": f"artist:{name}", "limit": SEARCH_LIMIT})
        artists = payload.get("artists")
        if not isinstance(artists, list):
            return []
        return [item for item in artists if isinstance(item, dict)]

    def match(self, name: str) -> dict | None:
        """El artista de MusicBrainz que corresponde a `name`, o None.

        Solo se acepta un candidato cuyo nombre plegado (o el de alguno de sus
        `aliases`, o su `sort-name`) sea EXACTAMENTE el buscado y que ademas
        tenga un score razonable. Sin coincidencia de nombre no hay match: un
        score alto con otro nombre es otra cosa (el programa "Late Motiv" no es
        la banda "Late Motiv").
        """
        candidates = self.search(name)
        if not candidates:
            return None
        wanted = fold(name)
        if not wanted:
            return None
        for candidate in candidates:
            score = _number(candidate.get("score"))
            if score is None or score < EXACT_SCORE:
                continue
            if wanted in _candidate_names(candidate):
                return candidate
        return None

    def genres(self, mbid: str) -> list[list]:
        """Generos del artista como `[[name, count], ...]`, de mas a menos."""
        payload = self._get(f"artist/{mbid}", {"inc": "genres"})
        return _clean_genres(payload.get("genres"))


class ListenBrainz:
    """Artistas similares de ListenBrainz Labs (decision 3 del ADR)."""

    def __init__(self, client: httpx.Client | None = None, *,
                 throttle: Throttle | None = None) -> None:
        self._client = client
        self._throttle = throttle if throttle is not None else LB_THROTTLE

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = _http_client()
        return self._client

    def similar(self, mbid: str) -> list[dict]:
        self._throttle.wait()
        resp = self.client.get(LB_URL, params={
            "artist_mbids": mbid, "algorithm": SIMILAR_ALGORITHM})
        resp.raise_for_status()
        payload = resp.json()
        if not isinstance(payload, list):
            return []
        out: list[dict] = []
        for row in payload:
            if not isinstance(row, dict):
                continue
            name = row.get("name")
            similar_mbid = row.get("artist_mbid") or row.get("mbid")
            score = _number(row.get("score"))
            if not isinstance(name, str) or not name.strip():
                continue
            if not isinstance(similar_mbid, str) or not similar_mbid:
                continue
            out.append({"name": name.strip(), "mbid": similar_mbid,
                        "score": max(0.0, score if score is not None else 0.0)})
        out.sort(key=lambda c: (-c["score"], c["name"]))
        return out[:MAX_SIMILAR]


class ArtistSource:
    """Arma la ficha completa de un artista con las dos APIs."""

    def __init__(self, musicbrainz: MusicBrainz | None = None,
                 listenbrainz: ListenBrainz | None = None, *,
                 clock=time.time) -> None:
        self._mb = musicbrainz if musicbrainz is not None else MusicBrainz()
        self._lb = (listenbrainz if listenbrainz is not None
                    else ListenBrainz())
        self._clock = clock

    def fetch(self, name: str, *, similar: bool = True) -> dict:
        """Ficha de `name`. Levanta si la red falla; el que llama decide."""
        when = self._clock()
        found = self._mb.match(name)
        if found is None:
            return unknown_record(name, when)
        mbid = found.get("id")
        if not isinstance(mbid, str) or not mbid:
            return unknown_record(name, when)
        display = found.get("name")
        if not isinstance(display, str) or not display.strip():
            display = name
        return {
            "name": display,
            "mbid": mbid,
            "genres": self._mb.genres(mbid),
            "similar": self._lb.similar(mbid) if similar else [],
            "fetched_at": when,
            "status": "ok",
            "rule": MATCH_RULE,
        }

    def fetch_genres(self, name: str) -> dict:
        """Como `fetch` pero sin similares (fase 2 del enricher)."""
        return self.fetch(name, similar=False)


# --------------------------------------------------------------- flujo de archivos
class ArtistInfoStorageMixin:
    """Lectura-modificacion-escritura de `artistinfo-<device>.json`.

    Los adapters solo implementan los cuatro hooks de archivo. La lectura
    mergea TODOS los dispositivos (gana el `fetched_at` mas nuevo) y la
    escritura toca unicamente el archivo propio.
    """

    # ------------------------------------------------------------- hooks
    def _artistinfo_device(self) -> str:
        raise NotImplementedError

    def _artistinfo_list(self) -> list[tuple[str, str]]:
        """`(ref, name)` de los archivos `artistinfo-*`."""
        raise NotImplementedError

    def _artistinfo_read(self, ref: str) -> bytes:
        raise NotImplementedError

    def _artistinfo_write(self, name: str, data: bytes,
                          ref: str | None = None) -> str:
        """Crea (ref None) o reemplaza y devuelve la ref nueva."""
        raise NotImplementedError

    # ------------------------------------------------------------ internos
    def _artistinfo_lock(self) -> threading.RLock:
        lock = getattr(self, "_artistinfo_mutex", None)
        if lock is None:
            lock = threading.RLock()
            self._artistinfo_mutex = lock
        return lock

    def _read_own_artistinfo(self, ref: str | None) -> ArtistInfoBook:
        if ref is None:
            return ArtistInfoBook()
        try:
            return ArtistInfoBook.from_bytes(self._artistinfo_read(ref))
        except Exception as exc:  # red o formato: no se pisa a ciegas
            raise RuntimeError(
                "no se pudo leer el artistinfo propio: no se sobrescribe"
            ) from exc

    # -------------------------------------------------------------- publico
    def load_artistinfo(self) -> dict[str, dict]:
        """Merge de las fichas de todos los dispositivos."""
        with self._artistinfo_lock():
            merged = ArtistInfoBook()
            listing = self._artistinfo_list()
            # Se leen todas las fichas: la nube las baja en paralelo antes.
            warm = getattr(self, "_warm_small", None)
            if warm is not None:
                warm([ref for ref, name in listing
                      if parse_artistinfo_file(name) is not None])
            for ref, name in listing:
                if parse_artistinfo_file(name) is None:
                    continue
                try:
                    book = ArtistInfoBook.from_bytes(
                        self._artistinfo_read(ref))
                except Exception as exc:
                    log.warning("artistinfo ilegible %s: %s", name, exc)
                    continue
                merged = merged.merged(book)
            return dict(merged.artists)

    def save_artistinfo(self, records: dict[str, dict]) -> None:
        """Escribe las fichas nuevas en el archivo de ESTE dispositivo.

        `records` viene indexado por nombre plegado. Si el archivo propio no se
        puede leer se levanta `RuntimeError`: escribir encima perderia lo que ya
        habia.
        """
        clean: dict[str, dict] = {}
        for key, raw in (records or {}).items():
            if not isinstance(key, str) or not key:
                continue
            record = _record_from_storage(raw)
            if record:
                clean[key] = record
        if not clean:
            return
        device = self._artistinfo_device()
        name = artistinfo_file(device)
        with self._artistinfo_lock():
            files = {file_name: ref
                     for ref, file_name in self._artistinfo_list()}
            ref = files.get(name)
            book = self._read_own_artistinfo(ref)
            for key, record in clean.items():
                old = book.artists.get(key)
                if old is None or record["fetched_at"] >= old.get(
                        "fetched_at", 0):
                    book.artists[key] = record
            self._artistinfo_write(name, book.to_bytes(), ref)


# --------------------------------------------------------------------- enricher
def _default_scan() -> list[dict]:
    from .downloader import library_scan
    return library_scan()


def _default_storage():
    from .storage import get_storage
    return get_storage()


def _default_records(storage) -> dict[str, dict]:
    return storage.load_artistinfo()


def _default_tracks(storage) -> dict:
    return (storage.load_listens_summary() or {}).get("tracks", {})


def _default_dismissed(storage) -> set[str]:
    return storage.load_discover().dismissed_set()


class Enricher:
    """Hilo unico que completa las fichas que faltan o estan vencidas.

    Primero los artistas de la biblioteca (mas pistas primero) y despues los
    generos de los 12 candidatos que recomienda Discover. Nunca bloquea una
    request: `ensure_started()` dispara el hilo y `status()` solo lee contadores.
    Tres errores de red seguidos lo dejan `offline` 60 s; la proxima llamada a
    `ensure_started()` lo vuelve a arrancar pasado ese tiempo.

    `load_records`, `load_tracks` y `load_dismissed` reciben el storage y leen
    sus entradas; el default va directo al storage. Discover pasa las suyas,
    cacheadas: asi el hilo no vuelve a listar la nube que la request acaba de leer.
    """

    def __init__(self, *, source: ArtistSource | None = None,
                 scan=None, storage=None, clock=time.time,
                 batch_size: int = ENRICH_BATCH,
                 cooldown: float = OFFLINE_COOLDOWN,
                 rerun_after: float = RERUN_AFTER,
                 load_records=None, load_tracks=None,
                 load_dismissed=None) -> None:
        self._source = source
        self._scan = scan or _default_scan
        self._storage = storage or _default_storage
        self._load_records = load_records or _default_records
        self._load_tracks = load_tracks or _default_tracks
        self._load_dismissed = load_dismissed or _default_dismissed
        self._clock = clock
        self._batch_size = max(1, int(batch_size))
        self._cooldown = float(cooldown)
        self._rerun_after = float(rerun_after)
        self._finished_at: float | None = None
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._running = False
        self._done = 0
        self._total = 0
        self._records: dict[str, dict] | None = None
        self._offline = False
        self._offline_until = 0.0

    # ------------------------------------------------------------- publico
    def ensure_started(self) -> None:
        """Arranca el hilo si hace falta. No hace nada si ya corre o espera.

        Los contadores NO se reinician aca: el plan de trabajo se publica
        cuando el hilo ya sabe cuantas fichas le faltan. Asi una request que
        arranca la proxima corrida nunca ve `{done: 0, total: 0, running: true}`.
        """
        with self._lock:
            if self._running:
                return
            if self._offline and self._clock() < self._offline_until:
                return
            if (not self._offline and self._finished_at is not None
                    and self._clock() - self._finished_at < self._rerun_after):
                return
            self._offline = False
            self._running = True
            self._thread = threading.Thread(
                target=self._run, name="artistinfo-enricher", daemon=True)
            self._thread.start()

    def status(self) -> dict:
        with self._lock:
            return {"done": self._done, "total": self._total,
                    "running": self._running, "offline": self._offline}

    def records(self) -> dict[str, dict] | None:
        """Copia de las fichas que el hilo ya tiene en memoria, o None.

        Discover la usa para no volver a leer todos los `artistinfo-*` en cada
        request: el que las tiene frescas es este hilo.
        """
        with self._lock:
            if self._records is None:
                return None
            return dict(self._records)

    # ------------------------------------------------------------ internos
    def _client(self) -> ArtistSource:
        if self._source is None:
            self._source = ArtistSource(clock=self._clock)
        return self._source

    def _advance(self) -> None:
        with self._lock:
            self._done += 1

    def _plan(self, count: int) -> None:
        """Suma trabajo al total: nunca lo baja ni reinicia `done`."""
        with self._lock:
            self._total += max(0, count)

    def _remember(self, records: dict[str, dict], folded: str,
                  record: dict) -> None:
        """Guarda la ficha en la copia compartida sin romper `records()`."""
        with self._lock:
            records[folded] = record

    def _go_offline(self) -> None:
        with self._lock:
            self._offline = True
            self._offline_until = self._clock() + self._cooldown

    def _flush(self, storage, batch: dict[str, dict]) -> None:
        if not batch:
            return
        try:
            storage.save_artistinfo(batch)
        except Exception as exc:
            # Sin persistencia la ficha se pierde, pero el hilo sigue: la
            # proxima corrida la vuelve a buscar.
            log.warning("no se pudo guardar artistinfo: %s", exc)

    def _run(self) -> None:
        try:
            self._work()
        except Exception:
            log.exception("el enricher de artistinfo fallo")
        finally:
            with self._lock:
                self._running = False
                self._thread = None
                self._finished_at = self._clock()

    def _work(self) -> None:
        storage = self._storage()
        entries = self._scan()
        library = library_artists(entries)
        # Copia: `_remember` la va completando y puede venir de una cache ajena.
        records = dict(self._load_records(storage))
        with self._lock:
            self._records = records
        now = self._clock()
        # Mas pistas primero; el nombre plegado desempata para que dos corridas
        # con la misma biblioteca hagan el mismo trabajo.
        pending = [folded for folded, info in sorted(
            library.items(), key=lambda item: (-item[1]["tracks"], item[0]))
            if is_stale(records.get(folded), now)]
        self._plan(len(pending))
        batch: dict[str, dict] = {}
        failures = 0
        for folded in pending:
            name = library[folded]["name"]
            try:
                record = self._client().fetch(name)
            except Exception as exc:
                log.warning("artistinfo de %s fallo: %s", name, exc)
                failures += 1
                record = error_record(name, self._clock(), records.get(folded))
            else:
                failures = 0
            batch[folded] = record
            self._remember(records, folded, record)
            self._advance()
            if len(batch) >= self._batch_size:
                self._flush(storage, batch)
                batch = {}
            if failures >= MAX_CONSECUTIVE_ERRORS:
                self._flush(storage, batch)
                self._go_offline()
                return
        self._flush(storage, batch)
        self._phase_two(storage, entries, library, records)

    def _phase_two(self, storage, entries: list[dict], library: dict,
                   records: dict[str, dict]) -> None:
        """Generos (MusicBrainz solo) de los 12 candidatos de Discover."""
        try:
            from . import recommend
            tracks = self._load_tracks(storage)
            dismissed = self._load_dismissed(storage)
            weights = recommend.artist_weights(library, entries, tracks)
            candidates = recommend.candidates(
                library, records, weights, dismissed)[:ENRICH_TOP_CANDIDATES]
        except Exception as exc:
            log.warning("no se pudieron calcular los candidatos: %s", exc)
            return
        now = self._clock()
        pending: list[tuple[str, str]] = []
        for candidate in candidates:
            folded = fold(candidate.get("name", ""))
            if folded and is_stale(records.get(folded), now):
                pending.append((folded, candidate["name"]))
        if not pending:
            return
        self._plan(len(pending))
        batch: dict[str, dict] = {}
        failures = 0
        for folded, name in pending:
            try:
                record = self._client().fetch_genres(name)
            except Exception as exc:
                log.warning("generos de %s fallaron: %s", name, exc)
                failures += 1
                record = error_record(name, self._clock(), records.get(folded))
            else:
                failures = 0
            batch[folded] = record
            self._remember(records, folded, record)
            self._advance()
            if len(batch) >= self._batch_size:
                self._flush(storage, batch)
                batch = {}
            if failures >= MAX_CONSECUTIVE_ERRORS:
                self._flush(storage, batch)
                self._go_offline()
                return
        self._flush(storage, batch)
