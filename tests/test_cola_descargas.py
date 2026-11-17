"""Cola global de descargas: limite, dedupe, persistencia, cancel, retry y resume.

Todo OFFLINE: `YtDlpSource.download` hace `import yt_dlp` perezoso, asi que
alcanza con un doble en `sys.modules`. Los tests de la cola no pegan a red y
usan un `queue_path` y un `TEMP_DIR` temporales para no tocar los reales.

La mayoria corre `downloads.enqueue` dentro de un `asyncio.run` para que los
workers (asyncio.create_task) se ejecuten; los tests de comandos puros parchean
`_schedule` a no-op para dejar los items quietos en "queued".
"""
from __future__ import annotations

import asyncio
import sys
import threading
import time
import types
from pathlib import Path

import pytest

from backend.app import downloads as d
from backend.app import ytdlp_source as ys
from backend.app.models import Track


# --------------------------------------------------------------------- doble
class FakeYoutubeDL:
    """Doble de yt-dlp: escribe .part, llama a los hooks y deja el final.

    Cuenta concurrentes e inicios (para el limite y el FIFO), guarda los opts
    (para `continuedl`) y puede ejecutar `en_tick` en cada paso (para cancelar
    a mitad de bajada desde el progress hook).
    """

    DURACION = 0.06
    TICKS = 8
    activas = 0
    max_activas = 0
    inicios: list[str] = []
    opts_vistas: list[dict] = []
    en_tick = None
    fallar: BaseException | None = None
    escribir_partial = True

    def __init__(self, opts):
        self.opts = opts
        type(self).opts_vistas.append(opts)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=True):
        tipo = type(self)
        tipo.activas += 1
        tipo.max_activas = max(tipo.max_activas, tipo.activas)
        tipo.inicios.append(self.opts["outtmpl"])
        try:
            home = Path(self.opts["paths"]["home"])
            home.mkdir(parents=True, exist_ok=True)
            rel = self.opts["outtmpl"].replace("%(ext)s", "mp3")
            final = home / rel
            if tipo.escribir_partial:
                (home / (rel + ".part")).write_bytes(b"parcial")
            for i in range(tipo.TICKS):
                if tipo.en_tick is not None:
                    tipo.en_tick(i)
                for hook in self.opts.get("progress_hooks", []):
                    hook({"status": "downloading",
                          "downloaded_bytes": i * 10,
                          "total_bytes": tipo.TICKS * 10})
                time.sleep(tipo.DURACION / tipo.TICKS)
            if tipo.fallar is not None:
                raise tipo.fallar
            final.write_bytes(b"final" + b"\x00" * 100)
            return {"filepath": str(final), "title": "Tema",
                    "uploader": "Artista", "duration": 10}
        finally:
            tipo.activas -= 1


def _modulo_falso() -> types.ModuleType:
    mod = types.ModuleType("yt_dlp")
    mod.YoutubeDL = FakeYoutubeDL
    return mod


def _limpiar_fake():
    for name, value in (("activas", 0), ("max_activas", 0), ("inicios", []),
                        ("opts_vistas", []), ("en_tick", None), ("fallar", None),
                        ("escribir_partial", True)):
        setattr(FakeYoutubeDL, name, value)
    ys._LOCKS_POR_RUTA.clear()


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setitem(sys.modules, "yt_dlp", _modulo_falso())
    _limpiar_fake()
    yield FakeYoutubeDL
    _limpiar_fake()


@pytest.fixture(autouse=True)
def _aislar(monkeypatch, tmp_path):
    """Cada test con cola, archivo y temp propios; activity vuelve a cero."""
    import backend.app.activity as act
    import backend.app.downloader as dl

    d.reset_for_tests()
    with act._lock:
        act._count = 0
        act._listeners = []
    monkeypatch.setattr(d, "queue_path", lambda: tmp_path / "cola.json")
    monkeypatch.setattr(dl, "TEMP_DIR", tmp_path / "temp")
    (tmp_path / "temp").mkdir(exist_ok=True)
    monkeypatch.setattr(ys, "RETRY_DELAYS_S", (0.0, 0.0))
    yield
    d.reset_for_tests()
    with act._lock:
        act._count = 0
        act._listeners = []


def spec(titulo: str, *, key: str | None = None) -> dict:
    t = Track(source="ytdlp", source_id="id-" + titulo, title=titulo,
              artist="Artista", extra={"webpage_url": "https://youtu.be/x"})
    payload = t.to_dict()
    payload.pop("downloadable", None)
    return {"source": "ytdlp", "track": payload, "fmt": "mp3", "media": "audio",
            "height": None, "query": None,
            "key_base": key or f"Artista/Artista - {titulo}"}


# -------------------------------------------------------------------- la cola
def test_limite_global_de_dos_y_fifo(fake, storage_temporal, tmp_path):
    storage_temporal(tmp_path / "lib")

    async def correr():
        salida = d.enqueue([spec(f"Tema {i}") for i in range(5)])
        await d.wait_item(salida[-1]["id"])

    asyncio.run(correr())

    assert fake.max_activas == 2
    # el semaforo es FIFO: arrancaron en el orden en que se encolaron
    assert fake.inicios == [f"Artista - Tema {i}.%(ext)s" for i in range(5)]
    assert all(it["status"] == "done" for it in d.get_items())


def test_dedupe_por_clave_salida(fake, storage_temporal, tmp_path):
    storage_temporal(tmp_path / "lib")

    async def correr():
        salida = d.enqueue([spec("Misma"), spec("Misma")])
        await d.wait_item(salida[0]["id"])
        return salida

    salida = asyncio.run(correr())
    assert salida[0]["id"] == salida[1]["id"]
    assert len(d.get_items()) == 1


def test_persistencia_round_trip_reanuda_como_queued(fake):
    salida = d.enqueue([spec("Uno"), spec("Dos")])
    d._update(salida[0]["id"], status="downloading", phase="preparing")
    assert (d.queue_path()).is_file(), "save escribio el JSON"

    # simular un reinicio: se pierde la memoria, queda el archivo
    d.reset_for_tests()
    d.load()

    items = {it["id"]: it for it in d.get_items()}
    assert set(items) == {salida[0]["id"], salida[1]["id"]}
    assert all(it["status"] == "queued" for it in items.values())
    assert all(it["phase"] is None for it in items.values())


def test_descarta_terminados_viejos_al_cargar():
    salida = d.enqueue([spec("Viejo"), spec("Reciente")])
    with d._LOCK:
        d._QUEUE[salida[0]["id"]]["status"] = "done"
        d._QUEUE[salida[0]["id"]]["updated_at"] = time.time() - 25 * 3600
    d._save()

    d.reset_for_tests()
    d.load()
    ids = [it["id"] for it in d.get_items()]
    assert salida[0]["id"] not in ids
    assert salida[1]["id"] in ids


def test_cancelar_encolado(monkeypatch):
    monkeypatch.setattr(d, "_schedule", lambda jid: None)
    jid = d.enqueue([spec("En cola")])[0]["id"]
    assert d.get_item(jid)["status"] == "queued"

    assert d.cancel(jid)["status"] == "cancelled"
    assert d.get_item(jid)["status"] == "cancelled"
    with pytest.raises(d.AlreadyFinished):
        d.cancel(jid)
    with pytest.raises(d.NotFound):
        d.cancel("no-existe")


def test_cancelar_en_curso_para_el_hook_y_borra_el_parcial(fake, monkeypatch,
                                                           storage_temporal,
                                                           tmp_path):
    storage_temporal(tmp_path / "lib")
    estado: dict[str, str] = {}

    def en_tick(tick):
        if tick == 2 and estado:
            d.cancel(estado["jid"])

    fake.en_tick = en_tick

    async def correr():
        salida = d.enqueue([spec("Cancelar")])
        estado["jid"] = salida[0]["id"]
        await d.wait_item(estado["jid"])

    asyncio.run(correr())

    item = d.get_item(estado["jid"])
    assert item["status"] == "cancelled"
    work = ys.partial_dir_for("Artista/Artista - Cancelar")
    assert not work.exists(), "el parcial se borra al cancelar"


def test_retry_de_item_terminado(monkeypatch):
    monkeypatch.setattr(d, "_schedule", lambda jid: None)
    jid = d.enqueue([spec("Fallido")])[0]["id"]
    with d._LOCK:
        d._QUEUE[jid]["status"] = "error"
        d._QUEUE[jid]["error"] = "boom"

    salida = d.retry(jid)
    assert salida == {"id": jid, "key": "Artista/Artista - Fallido"}
    item = d.get_item(jid)
    assert item["status"] == "queued"
    assert item["error"] is None
    with pytest.raises(d.AlreadyFinished):
        d.retry(jid)


def test_cancelar_grupo(monkeypatch):
    monkeypatch.setattr(d, "_schedule", lambda jid: None)
    g1 = {"id": "g1", "title": "Grupo", "artwork_url": None}
    g2 = {"id": "g2", "title": "Otro", "artwork_url": None}
    a = d.enqueue([spec("A"), spec("B")], g1)
    b = d.enqueue([spec("C")], g2)

    assert d.cancel_group("g1") == 2
    assert all(d.get_item(x["id"])["status"] == "cancelled" for x in a)
    assert d.get_item(b[0]["id"])["status"] == "queued"
    assert d.cancel_group("g1") == 0, "no cancela dos veces"


def test_activity_balanceado_durante_todo_el_periodo_ocupado(monkeypatch):
    import backend.app.activity as act

    vistos: list[bool] = []
    act.add_listener(vistos.append)
    monkeypatch.setattr(d, "_schedule", lambda jid: None)

    salida = d.enqueue([spec("X"), spec("Y")])
    assert act.is_busy() is True
    assert vistos == [True], "un solo begin para toda la racha ocupada"
    d.cancel(salida[0]["id"])
    assert act.is_busy() is True
    d.cancel(salida[1]["id"])
    assert act.is_busy() is False
    assert vistos == [True, False]
    act.remove_listener(vistos.append)


# -------------------------------------------------------------------- rutas
def test_progress_responde_queued_mientras_espera(cliente, monkeypatch):
    monkeypatch.setattr(d, "_schedule", lambda jid: None)
    jid = d.enqueue([spec("Espera")])[0]["id"]

    r = cliente.get(f"/api/download/progress/{jid}")
    assert r.status_code == 200
    assert r.json()["job_id"] == jid
    assert r.json()["status"] == "queued"


def test_post_download_devuelve_job_id_y_wait(cliente, monkeypatch,
                                               storage_temporal, tmp_path):
    storage_temporal(tmp_path / "lib")
    monkeypatch.setenv("YTDLP_ENABLED", "1")
    monkeypatch.setitem(sys.modules, "yt_dlp", _modulo_falso())
    from backend.app.sources import _register_ytdlp
    _register_ytdlp()

    body = {"source": "ytdlp", "fmt": "mp3",
            "track": {"source": "ytdlp", "source_id": "1", "title": "Normal",
                      "artist": "Artista",
                      "extra": {"webpage_url": "https://youtu.be/x"}}}
    r = cliente.post("/api/download", json=body)
    assert r.status_code == 200
    datos = r.json()
    assert datos["ok"] is True and datos["source"] == "ytdlp"
    assert isinstance(datos["job_id"], str) and datos["job_id"] in ys.JOBS
    # el trabajo background termina y libera el contador
    deadline = time.time() + 5
    while (time.time() < deadline
           and d.get_item(datos["job_id"])["status"] not in d.FINISHED):
        time.sleep(0.02)

    body["track"]["title"] = "ConWait"
    r = cliente.post("/api/download?wait=1", json=body)
    assert r.status_code == 200
    datos = r.json()
    assert datos["ok"] is True and datos["job_id"]
    assert datos["key"].endswith(".mp3"), "wait devuelve el resultado completo"


# ------------------------------------------------------------------- resume
def test_carpeta_estable_continuedl_y_borrado_al_terminar(fake, monkeypatch,
                                                          storage_temporal,
                                                          tmp_path):
    storage_temporal(tmp_path / "lib")
    key = "Artista/Artista - Resume"
    work = ys.partial_dir_for(key)
    assert ys.partial_dir_for(key) == work, "misma clave, misma carpeta"
    assert ys.partial_dir_for(key + " otra") != work
    assert work.parent == tmp_path / "temp"
    assert work.name.startswith("partial-")

    async def correr():
        salida = d.enqueue([spec("Resume", key=key)])
        await d.wait_item(salida[0]["id"])

    asyncio.run(correr())

    assert fake.opts_vistas[0]["continuedl"] is True
    assert not work.exists(), "se borra al terminar con exito"


def test_error_conserva_la_carpeta_para_el_reintento(fake, monkeypatch,
                                                     storage_temporal, tmp_path):
    storage_temporal(tmp_path / "lib")
    fake.fallar = RuntimeError("HTTP Error 503: Service Unavailable")
    key = "Artista/Artista - ErrorParcial"
    work = ys.partial_dir_for(key)

    async def correr():
        salida = d.enqueue([spec("ErrorParcial", key=key)])
        await d.wait_item(salida[0]["id"])
        return salida[0]["id"]

    jid = asyncio.run(correr())

    assert d.get_item(jid)["status"] == "error"
    assert work.is_dir(), "en error se conserva el .part para continuedl"
    assert any(p.name.endswith(".part") for p in work.iterdir())


def test_limpia_carpetas_parciales_viejas_al_arrancar(monkeypatch, tmp_path):
    import backend.app.downloader as dl

    temp = tmp_path / "temp"
    vieja = temp / "partial-vieja"
    fresca = temp / "partial-fresca"
    ajena = temp / "otra-carpeta"
    for carpeta in (vieja, fresca, ajena):
        carpeta.mkdir(parents=True)
    ahora = time.time()
    import os
    os.utime(vieja, (ahora - 25 * 3600, ahora - 25 * 3600))
    os.utime(fresca, (ahora, ahora))

    borradas = ys.cleanup_partials(now=ahora)

    assert borradas == 1
    assert not vieja.exists()
    assert fresca.exists() and ajena.exists(), "no toca las nuevas ni las ajenas"


def test_el_progreso_del_job_llega_al_item(monkeypatch):
    """GET /api/downloads lee el item: sin copiar `progress` mostraba 0 %."""
    monkeypatch.setattr(d, "_schedule", lambda jid: None)
    jid = d.enqueue([spec("Progreso")])[0]["id"]
    d._sync_from_job(jid, {"status": "downloading", "progress": 42.0})
    assert d.get_item(jid)["progress"] == 42.0


def test_un_aviso_tardio_no_deshace_la_cancelacion(monkeypatch):
    """El hook puede avisar progreso justo despues de cancelar."""
    monkeypatch.setattr(d, "_schedule", lambda jid: None)
    jid = d.enqueue([spec("Tardio")])[0]["id"]
    d.cancel(jid)
    d._sync_from_job(jid, {"status": "downloading", "phase": "downloading",
                           "progress": 50.0})
    assert d.get_item(jid)["status"] == "cancelled"
    d._sync_from_job(jid, {"status": "cancelled"})
    assert d.get_item(jid)["status"] == "cancelled"


# -------------------------------------------------- persistencia del progreso
def _item_con_job(monkeypatch):
    """Item quieto en cola + job 'downloading' para disparar el callback."""
    monkeypatch.setattr(d, "_schedule", lambda jid: None)
    jid = d.enqueue([spec("Progreso")])[0]["id"]
    ys.JOBS[jid] = {"status": "downloading", "phase": "downloading",
                    "progress": 1.0, "speed": None, "eta": None,
                    "title": "Progreso", "finished_at": None}
    return jid


def _reloj_y_guardados(monkeypatch):
    """Reloj falso para `downloads` y contador de `_save` (sin tocar el disco)."""
    ahora = [1000.0]

    class Reloj:
        @staticmethod
        def time():
            return ahora[0]

    monkeypatch.setattr(d, "time", Reloj)
    guardados: list[int] = []
    monkeypatch.setattr(d, "_save", lambda: guardados.append(1))
    return ahora, guardados


def test_varios_ticks_dentro_de_5s_no_reescriben_el_json(monkeypatch):
    jid = _item_con_job(monkeypatch)
    ahora, guardados = _reloj_y_guardados(monkeypatch)
    cb = d._progress_cb(jid)

    cb()  # primer tick: cambio de estado, guarda
    assert len(guardados) == 1
    ys.JOBS[jid]["progress"] = 50.0
    ahora[0] = 1001.1
    cb()  # avance en memoria, sin guardar
    assert d.get_item(jid)["progress"] == 50.0
    ahora[0] = 1002.2
    cb()
    ahora[0] = 1003.3
    cb()
    assert len(guardados) == 1, "los ticks dentro de 5s no tocan el JSON"


def test_cambio_de_status_o_phase_guarda_en_el_acto(monkeypatch):
    jid = _item_con_job(monkeypatch)
    ahora, guardados = _reloj_y_guardados(monkeypatch)
    cb = d._progress_cb(jid)

    cb()
    assert len(guardados) == 1
    ys.JOBS[jid]["phase"] = "converting"
    ahora[0] = 1000.5
    cb()  # gate de 1s: ni corre
    assert len(guardados) == 1
    ahora[0] = 1001.1
    cb()
    assert len(guardados) == 2, "el cambio de phase guarda sin esperar 5s"
    assert d.get_item(jid)["phase"] == "converting"


def test_tick_despues_de_5s_guarda(monkeypatch):
    jid = _item_con_job(monkeypatch)
    ahora, guardados = _reloj_y_guardados(monkeypatch)
    cb = d._progress_cb(jid)

    cb()  # guardado a t=1000
    ahora[0] = 1002.0
    cb()
    ahora[0] = 1003.0
    cb()
    assert len(guardados) == 1
    ahora[0] = 1000.0 + d.PROGRESS_SAVE_S + 0.1
    cb()
    assert len(guardados) == 2, "pasados 5s el tick vuelve a persistir"
