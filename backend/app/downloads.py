"""Cola global de descargas yt-dlp: concurrencia, persistencia y cancelacion.

Antes cada POST /api/download arrancaba un `asyncio.create_task` suelto: no
habia limite global, no se podia cancelar, los reintentos no sobrevivian a un
corte y un reinicio perdia la cola. Aca vive una cola FIFO con:

- un `asyncio.Semaphore` global de 2 descargas en curso;
- un item por descarga con el MISMO id del job (la ruta de progreso sigue
  funcionando sin cambios);
- persistencia atomica en `downloads-queue.json` dentro del dir de datos;
- cancelacion real (un Event que el progress hook de yt-dlp mira);
- reanudacion de trabajos parciales via `continuedl` (ver ytdlp_source).

Modulo neutral de starlette: lo llama main.py desde las rutas y desde el
lifespan. Todo el estado es de proceso y se guarda en disco en cada cambio que
importa.
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

from . import activity

log = logging.getLogger("spitifo.downloads")

# Maximo de descargas corriendo a la vez, global (no por ruta).
MAX_RUNNING = 2

# Los items terminados viven 24 h en la cola (para que la UI pueda reenganchar
# tras recargar) y se tiran del JSON al cargar y al guardar.
FINISHED_TTL_S = 24 * 3600.0

# El avance se copia al item como maximo 1 vez/s, pero el JSON solo se reescribe
# si cambio el estado o pasaron estos segundos: en el telefono cada write cuesta
# bateria (ver _progress_cb).
PROGRESS_SAVE_S = 5.0

# Estados por los que pasa un item. `queued` es "esperando el semaforo", el
# resto son los estados del job que ya publicaba ytdlp_source.
QUEUED = "queued"
ACTIVE = ("pending", "downloading", "processing", "saving")
FINISHED = ("done", "error", "cancelled")
BUSY_STATES = (QUEUED,) + ACTIVE

# Campos del job que se copian al item (y al JSON) para la vista de cola y para
# responder progreso aunque el proceso se haya reiniciado.
_RESULT_FIELDS = (
    "key", "filename", "size_mb", "format", "kind", "thumb_key", "height",
    "match", "match_label", "real_title", "downloaded_bytes", "speed", "eta",
)

_LOCK = threading.Lock()
_QUEUE: dict[str, dict] = {}
_CANCELS: dict[str, threading.Event] = {}
_DONE: dict[str, asyncio.Event] = {}
_BG_TASKS: set = set()

# El semaforo se ata al loop en su primer uso: los tests corren varios
# asyncio.run distintos en el mismo proceso y un semaforo con waiters de otro
# loop daria "attached to a different loop".
_SEMAPHORES: "weakref.WeakKeyDictionary" = None  # type: ignore[assignment]


def _init_semaphores():
    global _SEMAPHORES
    if _SEMAPHORES is None:
        import weakref
        _SEMAPHORES = weakref.WeakKeyDictionary()
    return _SEMAPHORES


def _semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    store = _init_semaphores()
    sem = store.get(loop)
    if sem is None:
        sem = asyncio.Semaphore(MAX_RUNNING)
        store[loop] = sem
    return sem


# activity: un unico begin/end para TODO el periodo ocupado (bordes 0->1 y
# 1->0), balanceado aunque haya muchas descargas simultaneas.
_activity_on = False


def _activity_update() -> None:
    global _activity_on
    with _LOCK:
        ocupado = any(it.get("status") in BUSY_STATES for it in _QUEUE.values())
        accion = None
        if ocupado and not _activity_on:
            _activity_on = True
            accion = True
        elif not ocupado and _activity_on:
            _activity_on = False
            accion = False
    if accion is True:
        activity.begin()
    elif accion is False:
        activity.end()


# ------------------------------------------------------------------ archivo
def queue_path() -> Path:
    from .cloud.tokens import default_data_dir
    return default_data_dir() / "downloads-queue.json"


def _purge_finished_locked(now: float) -> None:
    """Saca del dict los terminados viejos (se llama con _LOCK tomado)."""
    viejos = [i for i, it in _QUEUE.items()
              if it.get("status") in FINISHED
              and now - it.get("updated_at", now) > FINISHED_TTL_S]
    for i in viejos:
        _QUEUE.pop(i, None)


def _save() -> None:
    """Escribe atomico (temporal + replace) y purga terminados viejos.

    Sin `fsync`: este JSON es un espejo reconstruible de la cola, no un dato
    cuya durabilidad haya que garantizar. `os.replace` ya deja el archivo
    siempre en un estado completo (o el viejo o el nuevo), y en un telefono el
    fsync de cada tick de progreso es bateria y E/S regalados.
    """
    path = queue_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _LOCK:
            _purge_finished_locked(time.time())
            payload = {"items": [dict(it) for it in _QUEUE.values()]}
        tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
            f.flush()
        os.replace(tmp, path)
    except OSError as e:
        log.warning("no se pudo guardar la cola de descargas: %s", e)


def load() -> None:
    """Recupera la cola al arrancar. Los que estaban en curso vuelven a `queued`."""
    path = queue_path()
    if not path.is_file():
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        log.warning("no se pudo leer la cola de descargas: %s", e)
        return

    now = time.time()
    reanudar: list[str] = []
    with _LOCK:
        _QUEUE.clear()
        for raw in data.get("items") or []:
            if not isinstance(raw, dict) or not raw.get("id"):
                continue
            item = dict(raw)
            estado = item.get("status")
            if estado in FINISHED and now - item.get("updated_at", now) > FINISHED_TTL_S:
                continue
            if estado in BUSY_STATES:
                item["status"] = QUEUED
                item["phase"] = None
            item.setdefault("created_at", now)
            item.setdefault("updated_at", now)
            _QUEUE[item["id"]] = item
            if item["status"] == QUEUED:
                reanudar.append(item["id"])
        # Las senales de cancelacion/progreso son de este proceso: se crean
        # frescas para los items recuperados.
        for jid in list(_QUEUE):
            _CANCELS[jid] = threading.Event()
            _DONE[jid] = asyncio.Event()

    if reanudar:
        log.info("cola recuperada: %d descarga(s) vuelven a la cola", len(reanudar))
    _activity_update()
    for jid in reanudar:
        _ensure_job(jid)
        _schedule(jid)


# ------------------------------------------------------------------- helpers
def get_item(item_id: str) -> dict | None:
    with _LOCK:
        it = _QUEUE.get(item_id)
        return dict(it) if it is not None else None


def _update(item_id: str, *, save: bool = True, **campos) -> dict | None:
    with _LOCK:
        it = _QUEUE.get(item_id)
        if it is None:
            return None
        it.update(campos)
        it["updated_at"] = time.time()
        copia = dict(it)
    if save:
        _save()
    _activity_update()
    return copia


def _sync_from_job(item_id: str, job: dict, *, save: bool = False) -> None:
    """Copia el estado/publicacion del job al item (progreso en vivo)."""
    if not job:
        return
    cambios = {k: job[k] for k in ("status", "phase", "progress", *_RESULT_FIELDS,
                                   "error", "error_code")
               if k in job}
    # Un aviso de progreso que llega justo despues de cancelar no puede
    # devolver el item a "downloading": solo un estado final del job lo pisa.
    actual = (get_item(item_id) or {}).get("status")
    if actual == "cancelled" and cambios.get("status") not in FINISHED:
        cambios.pop("status", None)
        cambios.pop("phase", None)
    if cambios:
        _update(item_id, save=save, **cambios)


def _progress_cb(item_id: str):
    """Aviso del hook de yt-dlp: el item se actualiza 1 vez/s, pero el JSON
    solo se reescribe si cambio status/phase o pasaron PROGRESS_SAVE_S."""
    ultimo = [0.0]
    ultimo_save = [0.0]

    def cb() -> None:
        ahora = time.time()
        if ahora - ultimo[0] < 1.0:
            return
        ultimo[0] = ahora
        from .ytdlp_source import get_job
        job = get_job(item_id) or {}
        item = get_item(item_id) or {}
        cambio = (job.get("status") != item.get("status")
                  or job.get("phase") != item.get("phase"))
        guardar = cambio or ahora - ultimo_save[0] >= PROGRESS_SAVE_S
        if guardar:
            ultimo_save[0] = ahora
        _sync_from_job(item_id, job, save=guardar)

    return cb


def _to_track(item: dict):
    from .models import Track
    datos = dict(item.get("track") or {})
    datos.pop("downloadable", None)
    if item.get("source") == "itunes":
        extra = dict(datos.get("extra") or {})
        extra["from_itunes"] = True
        datos["extra"] = extra
    campos = {f.name for f in dataclasses.fields(Track)}
    return Track(**{k: v for k, v in datos.items() if k in campos})


def _ensure_job(item_id: str, item: dict | None = None) -> None:
    from .ytdlp_source import ensure_job
    it = item or get_item(item_id) or {}
    title = (it.get("track") or {}).get("title") or ""
    ensure_job(item_id, title)


def _schedule(item_id: str) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(_worker(item_id))
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)


# ------------------------------------------------------------------ la cola
def enqueue(specs: list[dict], group: dict | None = None) -> list[dict]:
    """Encola items y devuelve `[{id, key}]` en el orden pedido.

    Cada `spec` trae: source, track (dict), fmt, media, height, query y
    key_base. Si ya hay un item con la misma clave esperando o corriendo, no se
    crea otro: se devuelve el id existente (dedupe por archivo de salida).
    """
    now = time.time()
    salida: list[dict] = []
    nuevos: list[str] = []
    with _LOCK:
        for spec in specs:
            key = spec.get("key_base") or ""
            existente = next(
                (it for it in _QUEUE.values()
                 if it.get("key_base") == key and it.get("status") in BUSY_STATES),
                None)
            if existente is not None:
                salida.append({"id": existente["id"], "key": key})
                continue

            from .ytdlp_source import new_job
            jid = new_job((spec.get("track") or {}).get("title") or "")
            item = {
                "id": jid,
                "track": dict(spec.get("track") or {}),
                "source": spec.get("source") or "ytdlp",
                "fmt": spec.get("fmt") or "original",
                "media": spec.get("media") or "audio",
                "height": spec.get("height"),
                "query": spec.get("query"),
                "key_base": key,
                "ident": dict(spec.get("ident") or {}),
                "group": dict(group) if isinstance(group, dict) else None,
                "status": QUEUED,
                "phase": None,
                "progress": 0.0,
                "error": None,
                "error_code": None,
                "result": None,
                "created_at": now,
                "updated_at": now,
            }
            _QUEUE[jid] = item
            _CANCELS[jid] = threading.Event()
            _DONE[jid] = asyncio.Event()
            salida.append({"id": jid, "key": key})
            nuevos.append(jid)
    _save()
    _activity_update()
    for jid in nuevos:
        _schedule(jid)
    return salida


async def _worker(item_id: str) -> None:
    """Corre un item respetando el semaforo global; escribe cada cambio."""
    sem = _semaphore()
    async with sem:
        item = get_item(item_id)
        if item is None or item.get("status") in FINISHED:
            _finish_task(item_id)
            return
        _update(item_id, status="downloading", phase="preparing")

        from . import ytdlp_source as ys
        cancel = _CANCELS.get(item_id) or threading.Event()
        cb = _progress_cb(item_id)
        try:
            resultado = await ys.YtDlpSource().download(
                _to_track(item), item.get("fmt") or "original", job_id=item_id,
                query=item.get("query"), media=item.get("media") or "audio",
                height=item.get("height"), cancel=cancel, on_progress=cb)
            _update(item_id, result=resultado, save=False)
        except BaseException as e:
            if _es_cancel_local(e, cancel):
                _update(item_id, status="cancelled", phase=None, save=False)
            else:
                job = ys.get_job(item_id) or {}
                _update(item_id, status="error",
                        error=job.get("error") or str(e),
                        error_code=job.get("error_code"), save=False)
        finally:
            # El job es la verdad del estado final y de los campos de resultado.
            _sync_from_job(item_id, ys.get_job(item_id) or {}, save=True)
            _CANCELS.pop(item_id, None)
            _finish_task(item_id)


def _es_cancel_local(error: BaseException, cancel: threading.Event) -> bool:
    from .ytdlp_source import _es_cancel
    return cancel.is_set() or _es_cancel(error)


def _finish_task(item_id: str) -> None:
    ev = _DONE.get(item_id)
    if ev is not None and not ev.is_set():
        ev.set()


async def wait_item(item_id: str) -> None:
    """Espera a que el item termine (para `POST /api/download?wait=1`)."""
    ev = _DONE.get(item_id)
    if ev is not None:
        await ev.wait()


# ------------------------------------------------------------------- comandos
class NotFound(LookupError):
    """No existe un item con ese id."""


class AlreadyFinished(RuntimeError):
    """El item ya esta en estado final: no se puede cancelar/reintentar."""


def cancel(item_id: str) -> dict:
    """Cancela un item esperando o corriendo: 404 si no existe, 409 si termino."""
    with _LOCK:
        it = _QUEUE.get(item_id)
        if it is None:
            raise NotFound(item_id)
        if it.get("status") in FINISHED:
            raise AlreadyFinished(item_id)
        it["status"] = "cancelled"
        it["phase"] = None
        it["updated_at"] = time.time()
        copia = dict(it)
        ev = _CANCELS.get(item_id)
    if ev is not None:
        ev.set()
    _save()
    _activity_update()
    return copia


def cancel_group(group_id: str) -> int:
    """Cancela todos los items esperando/corriendo de un grupo. Devuelve cuantos."""
    ids: list[str] = []
    eventos: list[threading.Event] = []
    with _LOCK:
        for it in _QUEUE.values():
            grupo = it.get("group") or {}
            if (isinstance(grupo, dict) and grupo.get("id") == group_id
                    and it.get("status") not in FINISHED):
                it["status"] = "cancelled"
                it["phase"] = None
                it["updated_at"] = time.time()
                ids.append(it["id"])
                ev = _CANCELS.get(it["id"])
                if ev is not None:
                    eventos.append(ev)
    for ev in eventos:
        ev.set()
    if ids:
        _save()
        _activity_update()
    return len(ids)


def retry(item_id: str) -> dict:
    """Vuelve a encolar un item en error/cancelado con un id de job nuevo estado."""
    with _LOCK:
        it = _QUEUE.get(item_id)
        if it is None:
            raise NotFound(item_id)
        if it.get("status") not in FINISHED:
            raise AlreadyFinished(item_id)
        it.update(status=QUEUED, phase=None, progress=0.0,
                  error=None, error_code=None, key=None, filename=None,
                  result=None, updated_at=time.time())
        copia = dict(it)
        _CANCELS[item_id] = threading.Event()
        _DONE[item_id] = asyncio.Event()
    _ensure_job(item_id, copia)
    _save()
    _activity_update()
    _schedule(item_id)
    return {"id": item_id, "key": it.get("key_base")}


# -------------------------------------------------------------------- lectura
def _sort(items: list[dict]) -> list[dict]:
    """Grupo mas nuevo primero; dentro de un grupo, por fecha de creacion."""
    def gid(it: dict) -> str:
        grupo = it.get("group") or {}
        return (grupo.get("id") if isinstance(grupo, dict) else None) or it["id"]

    newest: dict[str, float] = {}
    for it in items:
        k = gid(it)
        newest[k] = max(newest.get(k, 0.0), it.get("created_at", 0.0))
    return sorted(items, key=lambda it: (-newest[gid(it)],
                                         -it.get("created_at", 0.0)))


def get_items() -> list[dict]:
    now = time.time()
    with _LOCK:
        items = [dict(it) for it in _QUEUE.values()]
    return _sort([it for it in items
                  if not (it.get("status") in FINISHED
                          and now - it.get("updated_at", now) > FINISHED_TTL_S)])


def list_payload() -> dict:
    items = get_items()
    return {
        "items": items,
        "running": sum(1 for it in items if it.get("status") in ACTIVE),
        "queued": sum(1 for it in items if it.get("status") == QUEUED),
    }


def job_view(item: dict) -> dict:
    """Forma de `job` que consume la ruta de progreso, desde un item persistido."""
    vista: dict[str, Any] = {
        "status": item.get("status") or "unknown",
        "progress": item.get("progress", 0.0),
        "speed": item.get("speed"),
        "eta": item.get("eta"),
        "title": (item.get("track") or {}).get("title"),
        "phase": item.get("phase"),
    }
    for k in _RESULT_FIELDS + ("error", "error_code"):
        if item.get(k) is not None:
            vista[k] = item[k]
    return vista


def reset_for_tests() -> None:
    """Deja el modulo como al arrancar (lo usan los tests de la cola)."""
    global _activity_on
    with _LOCK:
        _QUEUE.clear()
        _CANCELS.clear()
        _DONE.clear()
        estaba = _activity_on
        _activity_on = False
        _SEMAPHORES and _SEMAPHORES.clear()
    if estaba:
        activity.end()
