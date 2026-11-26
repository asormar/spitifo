"""Backend async: executores separados, timeouts de yt-dlp, guardado atomico
de la cola y arranque que no demora SPITIFO_READY. Todo OFFLINE: yt-dlp y la
red se reemplazan por dobles; nada de esto toca YouTube ni disco real fuera
de `tmp_path`.
"""
from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
import types

import pytest

from backend.app import downloads as d
from backend.app import executors as ex
from backend.app import ytdlp_source as ys


# ------------------------------------------------------------- pool de busqueda
@pytest.fixture(autouse=True)
def _pool_de_busqueda_limpio():
    """`_SEARCH_POOL`/`_SEARCH_INSTANCES_ALIVE`/`_SEARCH_POOL_SEMS` son estado de
    modulo compartido por toda la sesion de tests: sin esto, instancias o
    semaforos de un test anterior contaminan el conteo de este."""
    while not ys._SEARCH_POOL.empty():
        try:
            ys._SEARCH_POOL.get_nowait()
        except Exception:
            break
    ys._SEARCH_INSTANCES_ALIVE = 0
    ys._SEARCH_POOL_SEMS.clear()
    yield
    while not ys._SEARCH_POOL.empty():
        try:
            ys._SEARCH_POOL.get_nowait()
        except Exception:
            break
    ys._SEARCH_INSTANCES_ALIVE = 0
    ys._SEARCH_POOL_SEMS.clear()


class _YdlLento:
    """Doble de YoutubeDL para `_take_search_ydl`: cuenta instancias vivas a la
    vez (el pico, no el total) y tarda `duracion` en cada `extract_info`."""

    lock = threading.Lock()
    vivas = 0
    pico = 0
    creadas = 0
    duracion = 0.2

    def __init__(self, opts):
        type(self).creadas += 1

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, q, download=False):
        tipo = type(self)
        with tipo.lock:
            tipo.vivas += 1
            tipo.pico = max(tipo.pico, tipo.vivas)
        time.sleep(tipo.duracion)
        with tipo.lock:
            tipo.vivas -= 1
        return {"entries": []}

    def close(self):
        pass


def _reset_ydl_lento():
    _YdlLento.vivas = 0
    _YdlLento.pico = 0
    _YdlLento.creadas = 0


@pytest.fixture
def ydl_lento(monkeypatch):
    mod = types.ModuleType("yt_dlp")
    mod.YoutubeDL = _YdlLento
    monkeypatch.setitem(sys.modules, "yt_dlp", mod)
    _reset_ydl_lento()
    yield _YdlLento
    # El timeout corta la ESPERA del loop, no el hilo de abajo: dejarlo
    # terminar antes de resetear los contadores (compartidos entre tests)
    # evita que un hilo colgado de este test pise el conteo del siguiente.
    # Se chequea dos veces (con una pausa) porque un hilo que estaba
    # esperando el pool puede arrancar justo en el hueco entre lecturas.
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if _YdlLento.vivas == 0:
            time.sleep(0.05)
            if _YdlLento.vivas == 0:
                break
        time.sleep(0.02)
    _reset_ydl_lento()


# ----------------------------------------------------------- executores: forma
def test_los_tres_executores_son_pools_separados():
    """yt-dlp, storage y prefetch nunca comparten hilos entre si."""
    assert ex.YTDLP_EXECUTOR is not ex.STORAGE_EXECUTOR
    assert ex.YTDLP_EXECUTOR is not ex.PREFETCH_EXECUTOR
    assert ex.STORAGE_EXECUTOR is not ex.PREFETCH_EXECUTOR
    # Tamanos acotados para el telefono (4-8 nucleos, 4 GB): muy por debajo
    # del default de asyncio (min(32, cpu_count()+4)).
    assert ex.YTDLP_EXECUTOR._max_workers == ex.YTDLP_WORKERS
    assert ex.STORAGE_EXECUTOR._max_workers == ex.STORAGE_WORKERS
    assert ex.PREFETCH_EXECUTOR._max_workers == ex.PREFETCH_WORKERS
    # Suficientes para el pool de busqueda (3) MAS el limite global de
    # descargas concurrentes (`downloads.MAX_RUNNING`) MAS un margen para que
    # un resolve de un toque del usuario no haga cola detras de ambos.
    assert ex.YTDLP_WORKERS >= ys._SEARCH_POOL.maxsize + d.MAX_RUNNING + 1


def test_un_ytdlp_lento_no_bloquea_storage():
    """Una extraccion lenta en YTDLP_EXECUTOR no le saca un hilo a storage:
    es la garantia central de P-backend-async-1 (lectura de audio nunca detras
    de una busqueda)."""

    async def correr():
        bloqueando = threading.Event()
        liberar = threading.Event()

        def lento():
            bloqueando.set()
            liberar.wait(2)
            return "ytdlp listo"

        futuro_lento = ex.run_ytdlp(lento)
        await asyncio.get_event_loop().run_in_executor(None, bloqueando.wait, 2)

        t0 = time.monotonic()
        resultado_storage = await ex.run_storage(lambda: "storage listo")
        tardo = time.monotonic() - t0

        liberar.set()
        await futuro_lento
        return resultado_storage, tardo

    resultado_storage, tardo = asyncio.run(correr())
    assert resultado_storage == "storage listo"
    assert tardo < 0.5, "storage no deberia esperar a que termine la extraccion lenta"


# ---------------------------------------------------- timeouts de red yt-dlp
def test_search_candidates_corta_por_timeout(monkeypatch, ydl_lento):
    monkeypatch.setattr(ys, "YTDLP_CALL_TIMEOUT_S", 0.05)
    ydl_lento.duracion = 1.0
    src = ys.YtDlpSource()

    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(src.search_candidates("algo"))


def test_search_corta_por_timeout_y_lo_mapea_a_runtime_error(monkeypatch, ydl_lento):
    monkeypatch.setenv("YTDLP_ENABLED", "1")
    monkeypatch.setattr(ys, "YTDLP_CALL_TIMEOUT_S", 0.05)
    ydl_lento.duracion = 1.0
    src = ys.YtDlpSource()

    with pytest.raises(RuntimeError, match="timeout"):
        asyncio.run(src.search("algo"))


def test_resolve_corta_por_timeout_y_lo_mapea_a_runtime_error(monkeypatch, ydl_lento):
    from backend.app.models import Track

    monkeypatch.setattr(ys, "YTDLP_CALL_TIMEOUT_S", 0.05)
    ydl_lento.duracion = 1.0
    src = ys.YtDlpSource()
    track = Track(source="ytdlp", source_id="x", title="x", artist="x",
                  extra={"webpage_url": "https://youtu.be/x"})

    with pytest.raises(RuntimeError, match="timeout"):
        asyncio.run(src.resolve(track))


def test_probe_info_corta_por_timeout(monkeypatch, ydl_lento):
    monkeypatch.setattr(ys, "PROBE_TIMEOUT_S", 0.05)
    ydl_lento.duracion = 1.0

    with pytest.raises(RuntimeError, match="timeout"):
        asyncio.run(ys.probe_info("https://youtu.be/x"))


# --------------------------------------------- pool de busqueda, timeouts y cap
def test_el_pool_de_busqueda_nunca_pasa_de_tres_instancias_con_timeouts(
        monkeypatch, ydl_lento):
    """P-backend-async-3: un timeout no debe hacer que la siguiente racha de
    busquedas cree instancias de mas mientras las anteriores todavia corren
    en su hilo (la instancia sigue 'prestada' hasta que su extract_info
    termina de verdad)."""
    monkeypatch.setattr(ys, "YTDLP_CALL_TIMEOUT_S", 0.05)
    ydl_lento.duracion = 0.3
    src = ys.YtDlpSource()

    async def una(i):
        try:
            await src.search_candidates(f"q{i}")
        except asyncio.TimeoutError:
            pass

    async def correr():
        # Dos rachas seguidas: la primera vence su timeout mientras sus
        # hilos siguen corriendo; la segunda llega mientras la primera
        # todavia tiene instancias "prestadas".
        await asyncio.gather(*(una(i) for i in range(4)))
        await asyncio.sleep(0.02)
        await asyncio.gather(*(una(i) for i in range(4, 8)))

    asyncio.run(correr())
    assert ydl_lento.pico <= ys._SEARCH_POOL.maxsize, (
        "nunca deberia haber mas de maxsize instancias de YoutubeDL vivas a la vez")


def test_el_semaforo_de_busqueda_admite_como_mucho_el_tamano_del_pool(
        monkeypatch, ydl_lento):
    monkeypatch.setattr(ys, "YTDLP_CALL_TIMEOUT_S", 5.0)
    ydl_lento.duracion = 0.15
    src = ys.YtDlpSource()

    async def correr():
        await asyncio.gather(*(src.search_candidates(f"q{i}") for i in range(6)))

    asyncio.run(correr())
    assert ydl_lento.pico <= ys._SEARCH_POOL.maxsize
    assert ydl_lento.creadas <= ys._SEARCH_POOL.maxsize, (
        "6 busquedas concurrentes no deberian crear mas de 3 instancias")


# --------------------------------------------------------- guardado atomico
def _spec_minimo(jid: str, status: str = "queued") -> dict:
    return {"id": jid, "status": status, "updated_at": time.time(),
            "track": {}, "key": f"Artista/{jid}", "phase": None,
            "progress": 0.0, "error": None, "group": None}


def test_guardados_concurrentes_no_pisan_el_mas_reciente(monkeypatch, tmp_path):
    """Sin `_SAVE_LOCK`, un guardado que arranco antes pero tarda mas en
    escribir puede terminar DESPUES y pisar el archivo con una foto vieja
    (ver el comentario en downloads.py). Con el lock, el segundo guardado
    espera: nunca hay dos escrituras a la vez y la ultima en tomar la foto
    (la mas fresca) es la que efectivamente queda en disco."""
    monkeypatch.setattr(d, "queue_path", lambda: tmp_path / "cola.json")
    d.reset_for_tests()
    with d._LOCK:
        d._QUEUE["a"] = _spec_minimo("a", "queued")

    original_dump = json.dump
    pausar = threading.Event()
    seguir = threading.Event()

    def dump_lento(payload, f, **kw):
        pausar.set()
        seguir.wait(2)
        original_dump(payload, f, **kw)

    monkeypatch.setattr(d.json, "dump", dump_lento)

    t_lento = threading.Thread(target=d._save_sync)
    t_lento.start()
    assert pausar.wait(1), "el guardado lento deberia haber arrancado a escribir"

    with d._LOCK:
        d._QUEUE["a"]["status"] = "done"

    monkeypatch.setattr(d.json, "dump", original_dump)
    t_rapido = threading.Thread(target=d._save_sync)
    t_rapido.start()
    time.sleep(0.1)
    assert t_rapido.is_alive(), (
        "el guardado rapido debe esperar el lock, no escribir mientras el "
        "lento todavia tiene la foto vieja a mitad de camino")

    seguir.set()
    t_lento.join(2)
    t_rapido.join(2)
    assert not t_lento.is_alive() and not t_rapido.is_alive()

    data = json.loads((tmp_path / "cola.json").read_text(encoding="utf-8"))
    estados = {it["id"]: it["status"] for it in data["items"]}
    assert estados["a"] == "done", "el update mas reciente no se puede perder"


def test_guardado_es_atomico_temp_y_rename(monkeypatch, tmp_path):
    monkeypatch.setattr(d, "queue_path", lambda: tmp_path / "cola.json")
    d.reset_for_tests()
    with d._LOCK:
        d._QUEUE["a"] = _spec_minimo("a")

    d._save_sync()

    path = tmp_path / "cola.json"
    assert path.is_file()
    assert list(tmp_path.glob(".*.tmp")) == [], "no debe quedar ningun temporal"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["items"][0]["id"] == "a"


def test_save_async_no_bloquea_el_loop_corre_en_storage(monkeypatch, tmp_path):
    """Con un loop corriendo, `_save()` no escribe en el hilo que lo llama:
    lo manda a `STORAGE_EXECUTOR` (ver P-backend-async-6)."""
    monkeypatch.setattr(d, "queue_path", lambda: tmp_path / "cola.json")
    d.reset_for_tests()
    with d._LOCK:
        d._QUEUE["a"] = _spec_minimo("a")

    hilos_de_escritura: list[int] = []
    original = d._save_sync

    def _save_sync_instrumentado():
        hilos_de_escritura.append(threading.get_ident())
        return original()

    monkeypatch.setattr(d, "_save_sync", _save_sync_instrumentado)

    async def correr():
        hilo_del_loop = threading.get_ident()
        d._save()
        deadline = time.monotonic() + 2.0
        while not hilos_de_escritura and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        return hilo_del_loop

    hilo_del_loop = asyncio.run(correr())
    assert hilos_de_escritura, "_save_sync nunca corrio"
    assert hilos_de_escritura[0] != hilo_del_loop, (
        "con un loop corriendo, la escritura real debe pasar a otro hilo "
        "(STORAGE_EXECUTOR), no correr inline en el hilo del loop")


# --------------------------------------------------------- espera acotada
def test_wait_item_no_cuelga_para_siempre(monkeypatch):
    """P-backend-async-11: `wait_item` debe resolver dentro del plazo aunque
    el job nunca termine, devolviendo False (no una excepcion) para que el
    caller trate el job como 'sigue corriendo'."""
    monkeypatch.setattr(d, "WAIT_ITEM_TIMEOUT_S", 0.05)
    d.reset_for_tests()
    with d._LOCK:
        d._QUEUE["a"] = _spec_minimo("a", "downloading")
    d._DONE["a"] = asyncio.Event()  # nunca se setea

    async def correr():
        t0 = time.monotonic()
        termino = await d.wait_item("a")
        return termino, time.monotonic() - t0

    termino, tardo = asyncio.run(correr())
    assert termino is False
    assert tardo < 1.0


def test_wait_item_devuelve_true_si_termina_antes(monkeypatch):
    monkeypatch.setattr(d, "WAIT_ITEM_TIMEOUT_S", 2.0)
    d.reset_for_tests()
    d._DONE["a"] = asyncio.Event()

    async def correr():
        async def setear_pronto():
            await asyncio.sleep(0.02)
            d._DONE["a"].set()

        asyncio.ensure_future(setear_pronto())
        return await d.wait_item("a")

    assert asyncio.run(correr()) is True


# ------------------------------------------------------- arranque sin demora
def test_lifespan_no_espera_la_recuperacion_de_la_cola(monkeypatch):
    """P-backend-async-8: el server debe quedar listo aunque la recuperacion
    de la cola (disco) este colgada."""
    from starlette.testclient import TestClient

    from backend.app.main import create_app

    nunca = asyncio.Event()

    async def load_async_colgado():
        await nunca.wait()

    monkeypatch.setattr(d, "load_async", load_async_colgado)
    monkeypatch.setenv("YTDLP_ENABLED", "0")

    t0 = time.monotonic()
    with TestClient(create_app()):
        tardo = time.monotonic() - t0
    nunca.set()  # no deja la tarea de fondo colgada entre tests
    assert tardo < 2.0, "el arranque no debe esperar a la recuperacion de la cola"


# ------------------------------------------------------------------ prefetch
def test_prefetch_usa_su_propio_pool_acotado_sin_churn_de_hilos():
    """P-backend-async-5: antes, cada tap de 'siguiente' abria un
    `threading.Thread` crudo (sin pool, sin tope). Ahora se encola en
    `PREFETCH_EXECUTOR`: una racha de saltos reusa sus `PREFETCH_WORKERS`
    hilos en vez de abrir uno nuevo por tap."""
    import backend.app.main as main

    idents_usados: set[int] = set()
    lock = threading.Lock()
    terminados = threading.Event()
    contador = {"n": 0}
    TOTAL = 20

    def fn(key):
        with lock:
            idents_usados.add(threading.get_ident())
        time.sleep(0.02)
        with lock:
            contador["n"] += 1
            if contador["n"] == TOTAL:
                terminados.set()

    async def correr():
        for i in range(TOTAL):
            main._prefetch_submit(fn, f"clave-{i}")

    asyncio.run(correr())

    assert terminados.wait(5), "las 20 llamadas deberian terminar"
    assert len(idents_usados) <= ex.PREFETCH_WORKERS, (
        "una racha de saltos no deberia abrir mas hilos que PREFETCH_WORKERS")
