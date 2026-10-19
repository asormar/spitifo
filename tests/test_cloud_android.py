"""Tests OFFLINE del puente de tokens de Android (backend/app/cloud/android.py).

Un telefono real no entra aca: lo que se prueba es que, con
`SPITIFO_PLATFORM=android`, el flujo del sign-in, la marca persistida y el
adapter de Drive hagan lo que dice la ADR 0002 —sin navegador, sin
`oauth_clients.json` y sin tocar la red (Drive es `tests/fake_drive.py`)—.
"""
from __future__ import annotations

import threading
import time

import httpx
import pytest
from starlette.testclient import TestClient

from backend.app.cloud import android
from backend.app.cloud.android import (
    AndroidConnectFlow,
    android_tokens,
    connect_failed,
    is_android,
    is_google_connected,
    set_token,
)
from backend.app.cloud.drive import DriveStorage, drive_storage_from_env
from backend.app.cloud.oauth import OAuthNotConfigured
from backend.app.cloud.settings import (
    active_storage,
    google_connected,
    set_active_storage,
    set_google_connected,
)
from backend.app.cloud.tokens import ReconnectRequired, StaticTokenSource
from backend.app.main import create_app
from backend.app.storage import get_storage, set_storage
from fake_drive import FakeDrive


@pytest.fixture(autouse=True)
def android_env(monkeypatch, tmp_path):
    """Proceso "Android": variable puesta, datos y cache temporales, sin IDs."""
    monkeypatch.setenv("SPITIFO_PLATFORM", "android")
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SPITIFO_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("SPITIFO_LIBRARY", str(tmp_path / "library"))
    monkeypatch.delenv("SPITIFO_STORAGE", raising=False)
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_SECRET", raising=False)
    # La espera del primer token es de la app real; los tests existentes
    # quieren el fallo inmediato de siempre.
    monkeypatch.setattr(android, "STARTUP_TOKEN_WAIT_S", 0.0)
    # El token y el flujo son singletons de proceso: no se los deja al test que
    # sigue (monkeypatch restauraria el valor que hubiera al parchear, que ya
    # puede ser el de otro test).
    android._tokens = None
    android._flow = None
    yield tmp_path
    android._tokens = None
    android._flow = None
    set_storage(None)


@pytest.fixture
def api(monkeypatch):
    """TestClient con Drive sobre `FakeDrive` y el flujo de verdad de `main`.

    El flujo NO se monkeypatchea: `main._new_connect_flow` tiene que elegir el
    de Android solo, y eso es parte de lo que se prueba.
    """
    from backend.app import main as main_mod

    fake = FakeDrive()
    adapter = DriveStorage(
        android_tokens(), httpx.Client(transport=httpx.MockTransport(fake)),
        "dev", sleep=lambda s: None)
    monkeypatch.setattr("backend.app.cloud.drive.drive_storage_from_env",
                        lambda: adapter)
    main_mod._connect_flow = None
    try:
        with TestClient(create_app()) as c:
            yield c, fake
    finally:
        main_mod._connect_flow = None


def _flow():
    """El flujo que armo `main` (ya tiene que existir tras una request)."""
    from backend.app import main as main_mod
    return main_mod._connect_flow


# ------------------------------------------------------------------- la marca
def test_is_android_lee_la_variable_en_caliente(monkeypatch):
    assert is_android() is True
    monkeypatch.setenv("SPITIFO_PLATFORM", "Android")  # sin importar caja
    assert is_android() is True
    monkeypatch.delenv("SPITIFO_PLATFORM")
    assert is_android() is False


def test_la_marca_sobrevive_al_cambio_de_activo(tmp_path):
    set_google_connected(True, tmp_path)
    set_active_storage("google", tmp_path)
    assert google_connected(tmp_path) is True
    # Pasar a local no puede borrar la marca: es lo que distingue "desconectado"
    # de "conectado pero usando el disco".
    set_active_storage("local", tmp_path)
    assert google_connected(tmp_path) is True
    assert active_storage(tmp_path) == "local"
    set_google_connected(False, tmp_path)
    assert google_connected(tmp_path) is False
    assert active_storage(tmp_path) == "local"


def test_marcar_dos_veces_no_reescribe(tmp_path):
    set_google_connected(True, tmp_path)
    archivo = tmp_path / "storage.json"
    antes = archivo.stat().st_mtime_ns
    set_google_connected(True, tmp_path)  # idempotente: sin escritura
    assert archivo.stat().st_mtime_ns == antes


# --------------------------------------------------------------- el flujo solo
def test_set_token_sin_flujo_pendiente_no_conecta():
    """Un refresco silencioso al arrancar no es un sign-in del usuario."""
    flow = AndroidConnectFlow()
    set_token("tok", time.time() + 3600, interactive=False)
    assert flow.status()["state"] == "idle"
    assert is_google_connected() is True
    assert android_tokens().access_token() == "tok"


def test_start_deja_pending_y_devuelve_none():
    flow = AndroidConnectFlow()
    assert flow.start("google") is None
    assert flow.status() == {"state": "pending", "provider": "google",
                             "error": None}


def test_set_token_cierra_el_flujo_pendiente():
    conectados: list[str] = []
    flow = AndroidConnectFlow(on_connected=conectados.append)
    flow.start("google")
    set_token("tok", time.time() + 3600, interactive=True)
    assert flow.status()["state"] == "connected"
    assert flow.status()["error"] is None
    assert conectados == ["google"]


def test_connect_failed_deja_error():
    flow = AndroidConnectFlow()
    flow.start("google")
    connect_failed("Sign-in failed", cancelled=False)
    assert flow.status() == {"state": "error", "provider": "google",
                             "error": "Sign-in failed"}


def test_connect_failed_cancelado_no_es_error():
    flow = AndroidConnectFlow()
    flow.start("google")
    connect_failed("", cancelled=True)
    assert flow.status() == {"state": "cancelled", "provider": "google",
                             "error": None}


def test_lo_que_llega_sin_flujo_pendiente_no_cambia_el_estado():
    flow = AndroidConnectFlow()
    connect_failed("tarde", cancelled=False)
    assert flow.status()["state"] == "idle"


def test_cancel_sin_flujo_no_cambia_el_estado():
    flow = AndroidConnectFlow()
    flow.cancel()
    assert flow.status()["state"] == "idle"


def test_is_connected_es_la_marca():
    flow = AndroidConnectFlow()
    assert flow.is_connected("google") is False
    set_google_connected(True)
    assert flow.is_connected("google") is True
    # El token no participa: no hay ninguno empujado.
    with pytest.raises(ReconnectRequired):
        android_tokens().access_token()


# ----------------------------------------------------------- adapter de Drive
def test_drive_storage_from_env_usa_el_token_estatico(monkeypatch):
    """En Android el adapter lee el singleton y NUNCA el cliente de escritorio."""
    def _no_debe_leerse():
        raise AssertionError("Android no puede leer oauth_clients.json")

    monkeypatch.setattr("backend.app.cloud.drive.google_provider",
                        _no_debe_leerse)
    storage = drive_storage_from_env()
    assert isinstance(storage.tokens, StaticTokenSource)
    assert storage.tokens is android_tokens()
    set_token("tok", time.time() + 3600)
    assert storage.tokens.access_token() == "tok"


def test_get_storage_en_android_no_cae_a_local(monkeypatch, tmp_path):
    """Sin `oauth_clients.json`, elegir Drive en Android sigue siendo Drive."""
    set_active_storage("google", tmp_path)
    assert isinstance(get_storage(), DriveStorage)


def test_sin_android_el_adapter_pide_los_clientes(monkeypatch):
    """La PC sigue igual: sin client id, `drive_storage_from_env` no arma nada."""
    monkeypatch.delenv("SPITIFO_PLATFORM")
    with pytest.raises(OAuthNotConfigured):
        drive_storage_from_env()


# ------------------------------------------------------------------- la API
def test_get_muestra_android(api):
    c, fake = api
    body = c.get("/api/storage").json()
    assert isinstance(_flow(), AndroidConnectFlow)
    assert body["connect_via"] == "android"
    assert body["providers"] == [{
        "id": "google", "name": "Google Drive",
        "configured": True, "connected": False}]
    assert body["connect"] == {"state": "idle", "provider": None, "error": None}
    assert fake.calls == []


def test_connect_no_devuelve_url(api):
    c, _ = api
    r = c.post("/api/storage/connect", json={"provider": "google"})
    assert r.status_code == 202
    body = r.json()
    assert body["auth_url"] is None
    assert body["connect"]["state"] == "pending"


def test_set_token_conecta_y_deja_google_activo(api):
    c, fake = api
    c.post("/api/storage/connect", json={"provider": "google"})
    set_token("tok", time.time() + 3600, interactive=True)
    body = c.get("/api/storage").json()
    # `on_connected`: el ajuste pasa a google y el adapter se rearma solo.
    assert body["active"] == "google"
    assert body["library"] == "Google Drive: Spitifo"
    assert body["providers"][0]["connected"] is True
    # El token que usa la biblioteca es el que empujo Kotlin.
    assert android_tokens().access_token() == "tok"
    assert fake.calls  # la cuota si le pregunto a Drive


def test_connect_failed_se_ve_en_la_api(api):
    c, _ = api
    c.post("/api/storage/connect", json={"provider": "google"})
    connect_failed("Sign-in failed", cancelled=False)
    body = c.get("/api/storage").json()
    assert body["connect"] == {"state": "error", "provider": "google",
                               "error": "Sign-in failed"}
    assert body["providers"][0]["connected"] is False


def test_cancel_se_ve_en_la_api(api):
    c, _ = api
    c.post("/api/storage/connect", json={"provider": "google"})
    assert c.post("/api/storage/connect/cancel").json()["state"] == "cancelled"


def test_disconnect_borra_el_token_y_la_marca(api):
    c, _ = api
    c.post("/api/storage/connect", json={"provider": "google"})
    set_token("tok", time.time() + 3600, interactive=True)
    body = c.post("/api/storage/disconnect", json={"provider": "google"}).json()
    assert body["active"] == "local"
    assert body["providers"][0]["connected"] is False
    assert is_google_connected() is False
    with pytest.raises(ReconnectRequired):
        android_tokens().access_token()


def test_use_google_sin_conectar_es_409(api):
    c, _ = api
    r = c.post("/api/storage/use", json={"provider": "google"})
    assert r.status_code == 409
    assert r.json()["code"] == "not_connected"


def _drive_sin_token(api, monkeypatch, espera_s):
    """Rearma Drive con un origen creado despues de fijar la espera.

    El fixture `api` arma el adapter con la espera de la app; para probar el
    arranque hace falta que el `StaticTokenSource` vea el valor parcheado.
    """
    c, fake = api
    monkeypatch.setattr(android, "STARTUP_TOKEN_WAIT_S", espera_s)
    android._tokens = None
    adapter = DriveStorage(
        android_tokens(), httpx.Client(transport=httpx.MockTransport(fake)),
        "dev", sleep=lambda s: None)
    monkeypatch.setattr("backend.app.cloud.drive.drive_storage_from_env",
                        lambda: adapter)
    set_storage(None)
    set_google_connected(True)
    set_active_storage("google")
    return c


def test_library_espera_el_token_del_arranque(api, monkeypatch):
    c = _drive_sin_token(api, monkeypatch, 5.0)
    temporizador = threading.Timer(
        0.3, set_token, args=("tok", time.time() + 3600))
    temporizador.start()
    try:
        r = c.get("/api/library")
    finally:
        temporizador.cancel()
    assert r.status_code == 200
    assert r.json()["library"] == "Google Drive: Spitifo"


def test_library_falla_ya_si_el_refresco_silencioso_falla(api, monkeypatch):
    c = _drive_sin_token(api, monkeypatch, 5.0)
    inicio = time.monotonic()
    temporizador = threading.Timer(
        0.3, connect_failed, args=("silent refresh failed", False))
    temporizador.start()
    try:
        r = c.get("/api/library")
    finally:
        temporizador.cancel()
    assert r.status_code == 503
    assert r.json()["code"] == "reconnect_required"
    assert time.monotonic() - inicio < 3.0


def test_new_connect_flow_en_pc_es_el_del_loopback(monkeypatch):
    """La PC no cambia: sin `SPITIFO_PLATFORM` el flujo sigue siendo el de siempre."""
    from backend.app.cloud.connect import ConnectFlow
    from backend.app import main as main_mod

    monkeypatch.delenv("SPITIFO_PLATFORM")
    assert isinstance(main_mod._new_connect_flow(), ConnectFlow)
