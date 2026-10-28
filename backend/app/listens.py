"""Historial de escucha (ADR 0003, seccion Listening data).

Un evento es una foto de una sesion de escucha:

    {t, k, d, l, p, r, o, dev}

- `t`: segundos unix del cierre de la sesion.
- `k`: clave de la biblioteca.
- `d`: duracion de la pista en ms.
- `l`: tiempo escuchado en ms.
- `p`: posicion en ms al cerrar la sesion (extension del ADR; sirve para
  reanudar).
- `r`: motivo del cierre (`end|next|prev|change|close`).
- `o`: resultado (`play|skip|partial`).
- `dev`: dispositivo que escribe el evento.

Igual que las playlists, cada dispositivo escribe SOLO sus archivos y la vista
se arma mergeando todos:

    listens-<device>-YYYY-MM.json   eventos de ese mes
    listenagg-<device>.json         contadores por pista y artista

Este modulo es la parte pura (validacion, serializacion, score y merge) mas un
mixin con el flujo de lectura-modificacion-escritura. Los adapters de `storage`
ponen las cuatro operaciones de archivo.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field

from .storage import validate_key

log = logging.getLogger(__name__)

#: Version del formato. Un major distinto se rechaza en vez de adivinar.
VERSION = 1

#: Limites de la API.
MAX_EVENTS = 200

REASONS = frozenset({"end", "next", "prev", "change", "close"})
OUTCOMES = frozenset({"play", "skip", "partial"})

MONTH_PREFIX = "listens-"
AGG_PREFIX = "listenagg-"

#: Vida media del score, en dias. Es un valor inicial para ajustar en la
#: sesion de recomendaciones (ADR 0003).
HALF_LIFE_DAYS = 60.0

_MONTH_FILE_RE = re.compile(
    r"^" + re.escape(MONTH_PREFIX) + r"(?P<dev>.+)-(?P<month>\d{4}-\d{2})\.json$")
_AGG_FILE_RE = re.compile(
    r"^" + re.escape(AGG_PREFIX) + r"(?P<dev>.+)\.json$")


class ListenFormatError(ValueError):
    """El `listens-*`/`listenagg-*` remoto no tiene el formato que se entiende."""


# ------------------------------------------------------------------- eventos
def _is_int(value: object) -> bool:
    """Entero de verdad: `bool` es subclase de `int` y no es un numero."""
    return isinstance(value, int) and not isinstance(value, bool)


def validate_event(raw: object) -> dict:
    """Valida un evento de la API y lo devuelve sin `dev`.

    La API no acepta `dev`: lo pone el backend con el id de ESTE dispositivo.
    Levanta `ValueError` con un mensaje corto en castellano.
    """
    if not isinstance(raw, dict):
        raise ValueError("cada evento tiene que ser un objeto")
    t = raw.get("t")
    if not _is_int(t) or t < 0:
        raise ValueError("t tiene que ser un entero de segundos")
    key = raw.get("k")
    if not isinstance(key, str):
        raise ValueError("k tiene que ser texto")
    try:
        validate_key(key)
    except ValueError as exc:
        raise ValueError(f"k invalida: {exc}") from exc
    d = raw.get("d")
    if not _is_int(d) or d < 0:
        raise ValueError("d tiene que ser un entero de milisegundos")
    l = raw.get("l")
    if not _is_int(l) or l < 0:
        raise ValueError("l tiene que ser un entero de milisegundos")
    p = raw.get("p")
    if not _is_int(p) or p < 0:
        raise ValueError("p tiene que ser un entero de milisegundos")
    reason = raw.get("r")
    if reason not in REASONS:
        raise ValueError("r tiene que ser end, next, prev, change o close")
    outcome = raw.get("o")
    if outcome not in OUTCOMES:
        raise ValueError("o tiene que ser play, skip o partial")
    return {"t": t, "k": key, "d": d, "l": l, "p": p,
            "r": reason, "o": outcome}


def validate_events(raw: object) -> list[dict]:
    """Valida la lista completa de un POST (maximo `MAX_EVENTS`)."""
    if not isinstance(raw, list):
        raise ValueError("events tiene que ser una lista")
    if len(raw) > MAX_EVENTS:
        raise ValueError(f"no se aceptan mas de {MAX_EVENTS} eventos")
    return [validate_event(item) for item in raw]


def _event_from_storage(raw: object) -> dict | None:
    """Evento leido de un archivo. None si le falta algo o viene mal formado."""
    try:
        event = validate_event(raw)
    except ValueError:
        return None
    dev = raw.get("dev") if isinstance(raw, dict) else None
    if not isinstance(dev, str) or not dev:
        return None
    event["dev"] = dev
    return event


def month_of(seconds: int) -> str:
    """`YYYY-MM` en UTC del instante dado."""
    tm = time.gmtime(int(seconds))
    return f"{tm.tm_year:04d}-{tm.tm_mon:02d}"


def _month_index(month: str) -> int:
    year, mon = month.split("-")
    return int(year) * 12 + int(mon) - 1


def cutoff_month(now: float) -> str:
    """Primer mes que NO se pliega: el que esta a 12 meses de `now`."""
    tm = time.gmtime(int(now))
    index = tm.tm_year * 12 + (tm.tm_mon - 1) - 12
    year, mon = divmod(index, 12)
    return f"{year:04d}-{mon + 1:02d}"


def is_old_month(month: str, cutoff: str) -> bool:
    return _month_index(month) < _month_index(cutoff)


def month_file(device: str, month: str) -> str:
    return f"{MONTH_PREFIX}{device}-{month}.json"


def agg_file(device: str) -> str:
    return f"{AGG_PREFIX}{device}.json"


def parse_month_file(name: str) -> tuple[str, str] | None:
    """`(device, month)` desde `listens-<dev>-YYYY-MM.json`, o None."""
    found = _MONTH_FILE_RE.match(name)
    if not found:
        return None
    return found.group("dev"), found.group("month")


def parse_agg_file(name: str) -> str | None:
    """Device id desde `listenagg-<dev>.json`, o None."""
    found = _AGG_FILE_RE.match(name)
    return found.group("dev") if found else None


def artist_of(key: str) -> str:
    """Artista de una clave.

    Las claves normales son `<Artista>/<Artista> - <Titulo>.<ext>`, asi que el
    artista es el primer segmento. Sin carpeta se usa la parte anterior a
    `" - "` del nombre; si tampoco esta, el nombre sin extension.
    """
    if "/" in key:
        first = key.split("/", 1)[0]
        if first:
            return first
    name = key.rsplit("/", 1)[-1]
    if " - " in name:
        return name.split(" - ", 1)[0]
    dot = name.rfind(".")
    return name[:dot] if dot > 0 else name


# --------------------------------------------------------- serializacion
@dataclass
class ListenMonth:
    """Eventos de UN mes de UN dispositivo."""

    events: list[dict] = field(default_factory=list)
    version: int = VERSION

    def to_bytes(self) -> bytes:
        """JSON UTF-8 estable: los eventos van ordenados por tiempo."""
        events = sorted(self.events,
                        key=lambda e: (e.get("t", 0), e.get("dev", ""),
                                       e.get("k", ""), e.get("r", ""),
                                       e.get("o", ""), e.get("l", 0)))
        payload = {"version": self.version, "events": events}
        return json.dumps(payload, sort_keys=True,
                          ensure_ascii=False).encode("utf-8")

    @classmethod
    def from_bytes(cls, data: bytes) -> "ListenMonth":
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ListenFormatError("los listens no son JSON valido") from exc
        if not isinstance(payload, dict):
            raise ListenFormatError("los listens no son un objeto JSON")
        if payload.get("version") != VERSION:
            raise ListenFormatError(
                f"version de listens desconocida: {payload.get('version')!r}")
        events = payload.get("events")
        if not isinstance(events, list):
            raise ListenFormatError("los listens no traen events")
        return cls(events=[e for e in map(_event_from_storage, events) if e])


@dataclass
class Metric:
    """Contadores de una pista o un artista."""

    plays: int = 0
    skips: int = 0
    listened_ms: int = 0
    last: int = 0
    score: float = 0.0
    # Extension necesaria para resumir sin releer los eventos: posicion y
    # duracion del ultimo evento, y su resultado.
    pos: int = 0
    dur: int = 0
    o: str = ""

    def to_dict(self) -> dict:
        return {"plays": self.plays, "skips": self.skips,
                "listened_ms": self.listened_ms, "last": self.last,
                "score": self.score, "pos": self.pos, "dur": self.dur,
                "o": self.o}

    @classmethod
    def from_dict(cls, raw: object) -> "Metric | None":
        if not isinstance(raw, dict):
            return None
        values = {}
        for name in ("plays", "skips", "listened_ms", "last", "pos", "dur"):
            value = raw.get(name, 0)
            if not _is_int(value) or value < 0:
                return None
            values[name] = value
        score = raw.get("score", 0.0)
        if isinstance(score, bool) or not isinstance(score, (int, float)):
            return None
        outcome = raw.get("o", "")
        if outcome not in OUTCOMES and outcome != "":
            return None
        return cls(score=float(score), o=outcome, **values)


@dataclass
class ListenAggregate:
    """Agregado de UN dispositivo."""

    tracks: dict[str, Metric] = field(default_factory=dict)
    artists: dict[str, Metric] = field(default_factory=dict)
    folded_through: str | None = None
    version: int = VERSION

    def to_bytes(self) -> bytes:
        payload = {
            "version": self.version,
            "tracks": {k: self.tracks[k].to_dict()
                       for k in sorted(self.tracks)},
            "artists": {k: self.artists[k].to_dict()
                        for k in sorted(self.artists)},
            "folded_through": self.folded_through,
        }
        return json.dumps(payload, sort_keys=True,
                          ensure_ascii=False).encode("utf-8")

    @classmethod
    def from_bytes(cls, data: bytes) -> "ListenAggregate":
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ListenFormatError("el agregado no es JSON valido") from exc
        if not isinstance(payload, dict):
            raise ListenFormatError("el agregado no es un objeto JSON")
        if payload.get("version") != VERSION:
            raise ListenFormatError(
                f"version del agregado desconocida: {payload.get('version')!r}")
        tracks = payload.get("tracks", {})
        artists = payload.get("artists", {})
        if not isinstance(tracks, dict) or not isinstance(artists, dict):
            raise ListenFormatError("el agregado no trae tracks/artists")
        folded = payload.get("folded_through")
        if folded is not None and not isinstance(folded, str):
            raise ListenFormatError("folded_through invalido")
        return cls(
            tracks={k: m for k, m in ((k, Metric.from_dict(v))
                                      for k, v in tracks.items()) if m},
            artists={k: m for k, m in ((k, Metric.from_dict(v))
                                       for k, v in artists.items()) if m},
            folded_through=folded,
        )


# ------------------------------------------------------------------ score
def decay(score: float, seconds: float) -> float:
    """Aplica la vida media de 60 dias a un score."""
    if score <= 0 or seconds <= 0:
        return max(0.0, score)
    return max(0.0, score * 2.0 ** (-(seconds / 86400.0) / HALF_LIFE_DAYS))


def _apply_metric(metric: Metric, event: dict) -> None:
    """Suma UN evento a un contador.

    El score se decae hasta el instante del evento y despues se aplica el
    resultado. Un evento viejo (fuera de orden) no hace crecer el score por
    decaer "negativo": solo suma su delta.
    """
    when = event["t"]
    if metric.last and when > metric.last:
        metric.score = decay(metric.score, when - metric.last)
    outcome = event["o"]
    if outcome == "play":
        metric.plays += 1
        metric.score += 1.0
    elif outcome == "skip":
        metric.skips += 1
        metric.score = max(0.0, metric.score - 0.5)
    metric.score = max(0.0, metric.score)
    metric.listened_ms += event["l"]
    if when >= metric.last:
        metric.last = when
        metric.pos = event["p"]
        metric.dur = event["d"]
        metric.o = outcome


def apply_event(aggregate: ListenAggregate, event: dict) -> None:
    """Suma un evento a la pista y al artista."""
    metric = aggregate.tracks.setdefault(event["k"], Metric())
    _apply_metric(metric, event)
    artist = aggregate.artists.setdefault(artist_of(event["k"]), Metric())
    _apply_metric(artist, event)


def apply_events(aggregate: ListenAggregate, events: list[dict]) -> None:
    """Aplica un lote en orden temporal (el score depende del orden)."""
    for event in sorted(events, key=lambda e: e["t"]):
        apply_event(aggregate, event)


def merge_aggregates(aggregates: list[ListenAggregate],
                     now: float) -> ListenAggregate:
    """Merge de los agregados de todos los dispositivos.

    Los contadores se suman y `last` es el maximo. El score se recalcula por
    dispositivo y se suma ya decaido hasta `now`: es una aproximacion correcta
    (cada dispositivo guarda su score al instante de su ultimo evento) y evita
    reconstruir la historia completa desde los eventos, que ya pueden estar
    plegados.
    """
    merged = ListenAggregate()
    for aggregate in aggregates:
        merged.folded_through = max(filter(None, [
            merged.folded_through, aggregate.folded_through]), default=None)
        for source, target in ((aggregate.tracks, merged.tracks),
                               (aggregate.artists, merged.artists)):
            for key, metric in source.items():
                hit = target.get(key)
                if hit is None:
                    hit = Metric()
                    target[key] = hit
                hit.plays += metric.plays
                hit.skips += metric.skips
                hit.listened_ms += metric.listened_ms
                hit.score = max(0.0, hit.score + decay(
                    metric.score, max(0, now - metric.last)))
                if metric.last > hit.last or (
                        metric.last == hit.last and metric.o
                        and not hit.o):
                    hit.last = metric.last
                    hit.pos = metric.pos
                    hit.dur = metric.dur
                    hit.o = metric.o
    for metric in (*merged.tracks.values(), *merged.artists.values()):
        metric.score = max(0.0, metric.score)
    return merged


def summary(aggregates: list[ListenAggregate], now: float) -> dict:
    """Respuesta de GET /api/listens/summary."""
    merged = merge_aggregates(aggregates, now)
    tracks = {
        key: {"plays": m.plays, "skips": m.skips,
              "listened_ms": m.listened_ms, "last": m.last,
              "score": m.score, "pos": m.pos, "dur": m.dur}
        for key, m in merged.tracks.items()
    }
    recent = [
        {"key": key, "last": m.last, "pos": m.pos, "dur": m.dur, "o": m.o}
        for key, m in merged.tracks.items() if m.last
    ]
    recent.sort(key=lambda e: (-e["last"], e["key"]))
    return {"tracks": tracks, "recent": recent[:30]}


# ------------------------------------------------------- flujo de archivos
class ListensStorageMixin:
    """Lectura-modificacion-escritura de los archivos de escucha.

    Los adapters solo implementan las cuatro operaciones de archivo. Cada
    dispositivo escribe su propio `listens-*` y `listenagg-*`, asi que no hay
    escritura condicional: el lock serializa las peticiones del proceso.
    """

    # ------------------------------------------------------------- hooks
    def _listens_device(self) -> str:
        raise NotImplementedError

    def _listens_list(self) -> list[tuple[str, str]]:
        """`(ref, name)` de los archivos `listens-*` y `listenagg-*`."""
        raise NotImplementedError

    def _listens_read(self, ref: str) -> bytes:
        raise NotImplementedError

    def _listens_write(self, name: str, data: bytes,
                       ref: str | None = None) -> str:
        """Crea (ref None) o reemplaza y devuelve la ref nueva."""
        raise NotImplementedError

    def _listens_delete(self, ref: str) -> None:
        raise NotImplementedError

    # ------------------------------------------------------------ internos
    def _listens_lock(self) -> threading.RLock:
        lock = getattr(self, "_listens_mutex", None)
        if lock is None:
            lock = threading.RLock()
            self._listens_mutex = lock
        return lock

    def _read_aggregate(self, ref: str | None) -> tuple[ListenAggregate, bool]:
        """`(agregado, ilegible)`. Ausente = vacio y legible."""
        if ref is None:
            return ListenAggregate(), False
        try:
            return ListenAggregate.from_bytes(self._listens_read(ref)), False
        except Exception as exc:  # red o formato: no se pisa a ciegas
            log.warning("agregado de escucha ilegible: %s", exc)
            return ListenAggregate(), True

    def _read_month(self, ref: str | None) -> tuple[ListenMonth, bool]:
        if ref is None:
            return ListenMonth(), False
        try:
            return ListenMonth.from_bytes(self._listens_read(ref)), False
        except Exception as exc:
            log.warning("mes de escucha ilegible: %s", exc)
            return ListenMonth(), True

    def _all_events_for(self, device: str,
                        files: dict[str, str]) -> list[dict]:
        events: list[dict] = []
        for name, ref in files.items():
            parsed = parse_month_file(name)
            if not parsed or parsed[0] != device:
                continue
            month, unreadable = self._read_month(ref)
            if unreadable:
                continue
            events.extend(month.events)
        return events

    # -------------------------------------------------------------- publico
    def append_listens(self, events: list[dict],
                       now: float | None = None) -> int:
        """Valida, escribe el mes y actualiza el agregado de este dispositivo."""
        clean = [validate_event(event) for event in events]
        if not clean:
            return 0
        device = self._listens_device()
        stamp = int(now if now is not None else time.time())
        with self._listens_lock():
            files = {name: ref for ref, name in self._listens_list()}
            agg_name = agg_file(device)
            aggregate, unreadable = self._read_aggregate(files.get(agg_name))
            if unreadable:
                raise RuntimeError(
                    f"no se pudo leer {agg_name}: no se sobrescribe")

            # Cada evento al archivo de SU mes.
            grouped: dict[str, list[dict]] = {}
            for raw in clean:
                event = dict(raw)
                event["dev"] = device
                grouped.setdefault(month_of(event["t"]), []).append(event)
            for month, batch in grouped.items():
                name = month_file(device, month)
                ref = files.get(name)
                month_data, broken = self._read_month(ref)
                if broken:
                    raise RuntimeError(
                        f"no se pudo leer {name}: no se sobrescribe")
                month_data.events.extend(batch)
                ref = self._listens_write(name, month_data.to_bytes(), ref)
                files[name] = ref

            if agg_name in files:
                # El agregado ya tenia todo lo anterior: solo el lote nuevo.
                apply_events(aggregate, [dict(e, dev=device) for e in clean])
            else:
                # Sin agregado (primer uso o archivo perdido): se reconstruye
                # desde TODOS los meses, incluido el que se acaba de escribir.
                apply_events(aggregate,
                             self._all_events_for(device, files))

            # Plegado oportunista en cada append: la comprobacion es barata
            # porque solo mira los nombres de mes.
            self.fold_old_months(stamp, files=files, aggregate=aggregate)
        return len(clean)

    def fold_old_months(self, now: float | None = None, *,
                        files: dict[str, str] | None = None,
                        aggregate: ListenAggregate | None = None) -> int:
        """Borra los meses de mas de 12 meses y marca `folded_through`.

        Los eventos ya estan en el agregado (cada append lo actualiza), asi que
        plegar es borrar el mensual. Si el agregado no existe se reconstruye
        antes desde TODOS los meses para no perder el historial.
        Devuelve cuantos archivos se borraron.
        """
        stamp = int(now if now is not None else time.time())
        with self._listens_lock():
            device = self._listens_device()
            if files is None:
                files = {name: ref for ref, name in self._listens_list()}
            agg_name = agg_file(device)
            if aggregate is None:
                aggregate, unreadable = self._read_aggregate(
                    files.get(agg_name))
                if unreadable:
                    raise RuntimeError(
                        f"no se pudo leer {agg_name}: no se sobrescribe")
                if agg_name not in files:
                    apply_events(aggregate,
                                 self._all_events_for(device, files))
            cutoff = cutoff_month(stamp)
            deleted = 0
            for name in list(files):
                parsed = parse_month_file(name)
                if not parsed or parsed[0] != device:
                    continue
                if is_old_month(parsed[1], cutoff):
                    self._listens_delete(files.pop(name))
                    deleted += 1
            aggregate.folded_through = cutoff
            self._listens_write(agg_name, aggregate.to_bytes(),
                                files.get(agg_name))
            return deleted

    def load_listens_summary(self, now: float | None = None) -> dict:
        """Merge de los agregados de todos los dispositivos."""
        stamp = now if now is not None else time.time()
        with self._listens_lock():
            files = {
                name: ref
                for ref, name in self._listens_list()
                if parse_month_file(name) or parse_agg_file(name)
            }
            aggregates: list[ListenAggregate] = []
            with_agg: set[str] = set()
            # Se leen todos los agregados: si el adapter sabe bajarlos en
            # paralelo (nube), lo hace antes del bucle.
            warm = getattr(self, "_warm_small", None)
            if warm is not None:
                warm([ref for name, ref in files.items()
                      if parse_agg_file(name)])
            for name, ref in files.items():
                device = parse_agg_file(name)
                if device is None:
                    continue
                with_agg.add(device)
                aggregate, unreadable = self._read_aggregate(ref)
                if not unreadable:
                    aggregates.append(aggregate)
            # Un dispositivo sin agregado (por ejemplo, archivos viejos) se
            # reconstruye desde sus meses para no perder su historial.
            devices = {parse_month_file(name)[0] for name in files
                       if parse_month_file(name)}
            for device in devices - with_agg:
                rebuilt = ListenAggregate()
                apply_events(rebuilt, self._all_events_for(device, files))
                aggregates.append(rebuilt)
        return summary(aggregates, stamp)
