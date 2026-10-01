"""Dos descargas de la MISMA pista a la vez no se pisan.

Reproduce el bug real que se vio en la UI: al apretar dos resultados que
resuelven al mismo video de YouTube, la segunda descarga moria con

    [WinError 32] El proceso no tiene acceso al archivo porque esta siendo
    utilizado por otro proceso: library/The Beatles/The Beatles - Yesterday.webm

y el toast de la UI decia "Falló la descarga" sin dar ninguna razon. La causa no
era la UI (que ya trackea cada descarga por separado) sino que DOS jobs escriben
en la MISMA ruta de salida y Windows no deja abrir dos veces el mismo archivo.

El fix es `_lock_de_ruta` en `ytdlp_source.py`: una descarga por ruta.

Este test es OFFLINE y no usa red: `download()` hace `import yt_dlp` perezoso,
as que alcanza con poner un doble en `sys.modules`. El doble imita el lock de
Windows: si dos descargas tienen el archivo abierto al mismo tiempo, la segunda
tira `OSError(32)`, igual que el sistema. Con el lock roto, las dos descargas se
solapan y el test falla; con el lock, nunca se solapan y las dos terminan bien.

Para correrlo: `.venv/Scripts/python.exe -m pytest tests/test_descargas_concurrentes.py -q`
"""
from __future__ import annotations

import asyncio
import sys
import threading
import time
import types

import pytest

from backend.app.models import Track


# --------------------------------------------------------------------- dobles
class _ArchivoOcupado(Exception):
    """Lo que hace Windows cuando otro proceso tiene el archivo abierto."""


class YtDlpDoble:
    """Doble de `yt_dlp.YoutubeDL` que simula el lock de Windows.

    `extract_info` "tarda" un poco con el archivo tomado. Si otra descarga ya lo
    tiene abierto, revienta con OSError(32), que es EXACTAMENTE el error que
    veía el server. Asi el test falla si se pierde la serializacion.
    """

    #: cuanto "dura" la descarga, en segundos
    DURACION = 0.35
    #: cuantas descargas llegaron a abrir el archivo a la vez (deberia ser 1)
    maximo_concurrentes = 0
    #: cuantos intentos hubo, y cuantos fallaron con WinError 32
    intentos = 0
    fallos_lock = 0

    _turno = threading.Lock()
    _ocupado = threading.Lock()

    def __init__(self, opts):
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=True):
        tipo = type(self)
        with tipo._turno:
            tipo.intentos += 1
        # el outtmpl trae %(ext)s; el postprocessor deja mp3
        destino = self.opts["outtmpl"].replace("%(ext)s", "mp3")
        if not tipo._ocupado.acquire(blocking=False):
            with tipo._turno:
                tipo.fallos_lock += 1
                tipo.maximo_concurrentes = max(tipo.maximo_concurrentes, 2)
            raise OSError(32, "El proceso no tiene acceso al archivo porque "
                              "esta siendo utilizado por otro proceso")
        try:
            with tipo._turno:
                tipo.maximo_concurrentes = max(tipo.maximo_concurrentes, 1)
            time.sleep(tipo.DURACION)
            with open(destino, "wb") as f:
                f.write(b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 512)
            return {
                "filepath": destino,
                "title": "Yesterday (Live With Spoken Word Intro, New York)",
                "uploader": "The Beatles",
                "duration": 187,
            }
        finally:
            tipo._ocupado.release()


@pytest.fixture
def yt_dlp_doble(monkeypatch):
    """Pone el doble en `sys.modules` y limpia los contadores."""
    mod = types.ModuleType("yt_dlp")
    mod.YoutubeDL = YtDlpDoble
    monkeypatch.setitem(sys.modules, "yt_dlp", mod)

    from backend.app import ytdlp_source as ys

    YtDlpDoble.intentos = 0
    YtDlpDoble.fallos_lock = 0
    YtDlpDoble.maximo_concurrentes = 0
    # los locks por ruta son de proceso: entre tests hay que olvidarlos, o un
    # test anterior deja tomado el lock de esta ruta y la espera no se nota.
    ys._LOCKS_POR_RUTA.clear()
    yield YtDlpDoble
    ys._LOCKS_POR_RUTA.clear()


def _track(**extra) -> Track:
    return Track(
        source="ytdlp", source_id="yt-1",
        title="Yesterday", artist="The Beatles", album="Help!", year=1965,
        extra={"webpage_url": "https://youtu.be/abc", "from_itunes": True,
               **extra},
    )


def _jobs(n: int = 2) -> list[str]:
    """Crea los jobs como hace `main.py` antes de arrancar la tarea.

    `download()` solo crea el job si NO le pasan `job_id`: el caller lo crea
    antes a proposito, para que la UI sepa que id pollear desde el arranque.
    """
    from backend.app.ytdlp_source import new_job

    return [new_job("Yesterday") for _ in range(n)]


# ----------------------------------------------------------------------- tests
def test_dos_descargas_de_la_misma_pista_no_se_pisan(yt_dlp_doble):
    """Las dos terminan bien y nunca coexisten en el mismo archivo."""
    from backend.app.ytdlp_source import YtDlpSource

    src = YtDlpSource()
    job_a, job_b = _jobs(2)

    async def correr():
        return await asyncio.gather(
            src.download(_track(), job_id=job_a, query="Yesterday Beatles"),
            src.download(_track(), job_id=job_b, query="Yesterday Beatles"),
            return_exceptions=True,
        )

    res = asyncio.run(correr())

    errores = [r for r in res if isinstance(r, BaseException)]
    assert not errores, f"una descarga fallo: {errores}"
    assert yt_dlp_doble.fallos_lock == 0, (
        "hubo un choque de archivo: el lock por ruta no serializa")
    assert yt_dlp_doble.maximo_concurrentes == 1, (
        "dos descargas tuvieron el archivo abierto a la vez")

    # las dos terminaron en el mismo archivo final, que es lo que se busca: el
    # nombre en la biblioteca es el canonico, no "Yesterday (2).mp3"
    rutas = {r["path"] for r in res}
    assert len(rutas) == 1
    assert rutas.pop().endswith("The Beatles - Yesterday.mp3")


def test_el_segundo_job_se_publica_como_pending(yt_dlp_doble):
    """Mientras espera al lock, el job dice `pending` y no `downloading`.

    La UI muestra "En cola" para `pending`: si el job se publicara como
    `downloading` en 0%, el toast mentiria durante toda la espera.
    """
    from backend.app.ytdlp_source import YtDlpSource, get_job

    src = YtDlpSource()
    job_a, job_b = _jobs(2)

    async def correr():
        return await asyncio.gather(
            src.download(_track(), job_id=job_a, query="Yesterday Beatles"),
            src.download(_track(), job_id=job_b, query="Yesterday Beatles"),
        )

    estados: list[str] = []

    async def mirando():
        for _ in range(80):
            j = get_job(job_b) or {}
            estados.append(j.get("status", "?"))
            await asyncio.sleep(0.02)

    async def ambas():
        return await asyncio.gather(correr(), mirando())

    asyncio.run(ambas())

    assert "pending" in estados, (
        f"el job en espera nunca se publico como pending: {sorted(set(estados))}")
    assert estados[-1] == "done"


def test_el_lock_se_suelta_tras_el_error(yt_dlp_doble):
    """Si una descarga explota, la siguiente no queda esperando para siempre.

    Un `asyncio.Lock` sin `finally` deja el camino poisonsado y todos los jobs
    futuros de esa pista cuelgan: esto lo cubre.
    """
    from backend.app import ytdlp_source as ys

    src = ys.YtDlpSource()
    lock = ys._lock_de_ruta("ruta/de/prueba")

    async def falla():
        with pytest.raises(RuntimeError):
            async with lock:
                raise RuntimeError("boom")

    async def despues():
        # si el lock quedara tomado, esto colgaria para siempre
        async with lock:
            return "sigue funcionando"

    async def correr():
        await falla()
        return await asyncio.wait_for(despues(), timeout=2.0)

    assert asyncio.run(correr()) == "sigue funcionando"
