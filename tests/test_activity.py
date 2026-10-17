"""Contador de actividad: transiciones, anidado, errores y enganche en la API.

Todo OFFLINE. `backend.app.activity` es un modulo neutral (sin starlette ni
uvicorn): el server lo llama desde `main.download()` para que el shell de
Android sepa cuando arrancar y cuando apagar el foreground service. Los avisos
son best-effort: un listener roto no puede tumbar una descarga.

La parte final pega contra la app en proceso con el TestClient de conftest y
verifica lo que el shell realmente ve: que el contador vuelve a 0 aunque la
request falle (400 por fuente desconocida, 502 por una descarga que explota).
"""
from __future__ import annotations

import logging
import threading

import pytest


@pytest.fixture
def actividad():
    """Deja el modulo en cero antes y despues: el estado es global."""
    from backend.app import activity

    with activity._lock:
        activity._count = 0
        activity._listeners = []
    yield activity
    with activity._lock:
        activity._count = 0
        activity._listeners = []


# ------------------------------------------------------------------ transiciones
def test_avisa_solo_en_los_bordes(actividad):
    """0->1 avisa True; 1->0 avisa False; las cuentas intermedias no avisan."""
    eventos: list[bool] = []
    actividad.add_listener(eventos.append)

    actividad.begin()   # 0 -> 1: avisa
    actividad.begin()   # 1 -> 2: no
    actividad.end()     # 2 -> 1: no
    actividad.end()     # 1 -> 0: avisa

    assert eventos == [True, False]
    assert actividad.is_busy() is False


def test_end_con_el_contador_en_cero_es_noop(actividad):
    """Un end de mas no baja de 0 ni avisa."""
    eventos: list[bool] = []
    actividad.add_listener(eventos.append)

    actividad.end()
    actividad.end()
    assert actividad.is_busy() is False
    assert eventos == []

    # y el contador sigue usable despues
    actividad.begin()
    assert actividad.is_busy() is True
    actividad.end()
    assert eventos == [True, False]


def test_anidado_sigue_ocupado_hasta_el_ultimo_end(actividad):
    eventos: list[bool] = []
    actividad.add_listener(eventos.append)

    with actividad.busy():
        with actividad.busy():
            assert actividad.is_busy() is True
        # el bloque interno no apago el contador
        assert actividad.is_busy() is True
    assert actividad.is_busy() is False
    assert eventos == [True, False]


def test_remove_listener_deja_de_avisar(actividad):
    vistos: list[bool] = []
    actividad.add_listener(vistos.append)
    actividad.begin()
    actividad.end()
    actividad.remove_listener(vistos.append)
    actividad.begin()
    actividad.end()
    # solo los dos avisos de antes
    assert vistos == [True, False]


def test_remove_listener_inexistente_no_rompe(actividad):
    actividad.remove_listener(lambda activo: None)  # no estaba: no hace nada
    assert actividad.is_busy() is False


# ------------------------------------------------------------------- listeners
def test_un_listener_que_falla_no_rompe_a_los_demas(actividad, caplog):
    vistos: list[bool] = []

    def malo(activo):
        raise RuntimeError("boom")

    actividad.add_listener(malo)
    actividad.add_listener(vistos.append)

    with caplog.at_level(logging.ERROR, logger="spitifo.activity"):
        actividad.begin()  # no propaga la excepcion del listener

    assert vistos == [True]
    assert actividad.is_busy() is True

    actividad.end()
    assert vistos == [True, False]
    assert any("listener de actividad fallo" in r.getMessage()
               for r in caplog.records), caplog.text


# ------------------------------------------------------------------------ busy
def test_busy_suelta_el_contador_si_el_bloque_explota(actividad):
    eventos: list[bool] = []
    actividad.add_listener(eventos.append)

    with pytest.raises(ValueError):
        with actividad.busy():
            assert actividad.is_busy() is True
            raise ValueError("boom")

    assert actividad.is_busy() is False
    assert eventos == [True, False]


def test_smoke_de_concurrencia(actividad):
    """Muchos begin/end en paralelo: el contador no se pierde ni queda colgado.

    Los avisos se mandan fuera del lock, asi que el ORDEN no esta garantizado
    (un True puede entregarse despues del False que lo compensa). Lo que si
    tiene que cumplirse es que cada transicion avisa una vez: los True y los
    False quedan balanceados y el contador termina en 0.
    """
    eventos: list[bool] = []
    candado = threading.Lock()

    def listener(activo):
        with candado:
            eventos.append(activo)

    actividad.add_listener(listener)

    hilos, por_hilo = 8, 200

    def trabajador():
        for _ in range(por_hilo):
            actividad.begin()
            actividad.end()

    ts = [threading.Thread(target=trabajador) for _ in range(hilos)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()

    assert actividad.is_busy() is False
    assert eventos.count(True) == eventos.count(False)
    assert eventos.count(True) >= 1


# --------------------------------------------------------------- main.download
def test_download_fuente_desconocida_no_deja_actividad_colgada(cliente, actividad):
    """Un error de validacion (400) pasa ANTES de tocar el contador."""
    r = cliente.post("/api/download", json={
        "source": "napster",
        "track": {"source": "x", "source_id": "1", "title": "t", "artist": "a"},
        "fmt": "mp3"})
    assert r.status_code == 400
    assert actividad.is_busy() is False


def test_download_que_falla_devuelve_la_actividad_a_cero(cliente, monkeypatch,
                                                         actividad):
    """`download_track` explota => 502, y el contador igual vuelve a 0."""
    import backend.app.main as m

    eventos: list[bool] = []
    actividad.add_listener(eventos.append)

    async def explota(track, fmt="original"):
        raise RuntimeError("boom")

    monkeypatch.setattr(m, "download_track", explota)
    r = cliente.post("/api/download", json={
        "source": "wikimedia",
        "track": {"source": "wikimedia", "source_id": "1", "title": "Tono",
                  "artist": "Prueba", "audio_url": "https://example.org/tono.ogg"},
        "fmt": "original"})

    assert r.status_code == 502
    assert actividad.is_busy() is False
    assert eventos == [True, False]
