"""Tests OFFLINE de `/api/storage` (pantalla de conexion, backend/app/main.py).

El flujo del proceso se reemplaza por uno con navegador doble y
`httpx.MockTransport`, y el adapter de Drive por un `DriveStorage` sobre
`tests/fake_drive.py`: el `GET /api/storage` no puede golpear la red.
"""
from __future__ import annotations

import threading
import time
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from starlette.testclient import TestClient

from backend.app.cloud.connect import ConnectFlow
from backend.app.cloud.drive import DriveStorage
from backend.app.cloud.settings import set_active_storage
from backend.app.cloud.tokens import PlainProtector, TokenStore
from backend.app.main import create_app
from backend.app.storage import reset_storage, set_storage
from fake_drive import FakeDrive


class Tokens:
    """`TokenSource` fijo: el GET no abre descargas, solo describe la boveda."""

    def access_token(self) -> str:
        return "tok"

    def invalidate(self) -> None:
        pass


def _token_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={
        "access_token": "at", "refresh_token": "rt", "expires_in": 3600})


class FakeBrowser:
    """Navegador doble: vuelve al loopback con el `state` de la URL."""

    def __init__(self, delay: float = 0.05) -> None:
        self.delay = delay
        self.urls: list[str] = []

    def __call__(self, url: str) -> None:
        self.urls.append(url)
        query = parse_qs(urlparse(url).query)
        redirect = query["redirect_uri"][0]
        target = f"{redirect}?state={query['state'][0]}&code=CODE"

        def _go() -> None:
            if self.delay:
                time.sleep(self.delay)
            try:
                httpx.get(target, timeout=5.0)
            except Exception:
                pass

        threading.Thread(target=_go, daemon=True).start()


@pytest.fixture
def api(monkeypatch, tmp_path):
    """TestClient con el flujo y el adapter de Drive reemplazados."""
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SPITIFO_GOOGLE_CLIENT_ID", "gid")
    monkeypatch.setenv("SPITIFO_GOOGLE_CLIENT_SECRET", "gsecret")
    monkeypatch.delenv("SPITIFO_STORAGE", raising=False)

    from backend.app.cloud import oauth
    monkeypatch.setattr(oauth, "BUNDLED_CONFIG", tmp_path / "nada.json")

    fake = FakeDrive()
    adapter = DriveStorage(
        Tokens(), httpx.Client(transport=httpx.MockTransport(fake)), "dev",
        sleep=lambda s: None)
    monkeypatch.setattr("backend.app.cloud.drive.drive_storage_from_env",
                        lambda: adapter)

    store = TokenStore(tmp_path / "tokens", PlainProtector())
    conectados: list[str] = []

    def _on_connected(provider: str) -> None:
        conectados.append(provider)
        set_active_storage(provider)
        reset_storage()

    browser = FakeBrowser()
    flow = ConnectFlow(store, browser=browser,
                       client_factory=lambda: httpx.Client(
                           transport=httpx.MockTransport(_token_handler),
                           timeout=5.0),
                       on_connected=_on_connected)

    from backend.app import main as main_mod
    monkeypatch.setattr(main_mod, "_new_connect_flow", lambda: flow)
    monkeypatch.setattr(main_mod, "_connect_flow", None)

    try:
        with TestClient(create_app()) as c:
            yield c, fake, store, conectados, browser
    finally:
        set_storage(None)
        main_mod._connect_flow = None


def _wait_connected(c: TestClient, timeout: float = 8.0) -> dict:
    """Espera a que el flujo termine: tokens guardados Y google como activo.

    `on_connected` guarda el ajuste despues de los tokens, asi que mirar solo
    `connected` puede leer un cuerpo anterior al cambio de activo.
    """
    limite = time.monotonic() + timeout
    while time.monotonic() < limite:
        body = c.get("/api/storage").json()
        if body["providers"][0]["connected"] and body["active"] == "google":
            return body
        time.sleep(0.02)
    raise AssertionError("el proveedor nunca quedo conectado y activo")


# --------------------------------------------------------------------- GET
def test_get_muestra_local(api):
    c, fake, _, _, _ = api
    r = c.get("/api/storage")
    assert r.status_code == 200
    body = r.json()
    assert body["active"] == "local"
    assert body["providers"] == [{
        "id": "google", "name": "Google Drive",
        "configured": True, "connected": False}]
    assert body["connect"] == {"state": "idle", "provider": None, "error": None}
    assert "library" in body
    assert fake.calls == []  # el GET no golpeo la red


# ------------------------------------------------------------------ connect
def test_connect_devuelve_la_url(api):
    c, _, _, _, _ = api
    r = c.post("/api/storage/connect", json={"provider": "google"})
    assert r.status_code == 202
    body = r.json()
    assert body["auth_url"].startswith("https://accounts.google.com/")
    assert body["connect"]["state"] in ("pending", "connected")


def test_conectar_deja_google_activo(api):
    c, fake, _, conectados, _ = api
    c.post("/api/storage/connect", json={"provider": "google"})
    body = _wait_connected(c)
    assert conectados == ["google"]
    assert body["active"] == "google"
    assert body["library"] == "Google Drive: Spitifo"
    assert fake.calls == []


def test_connect_sin_configuracion_es_409(api, monkeypatch):
    c, _, _, _, _ = api
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_SECRET", raising=False)
    r = c.post("/api/storage/connect", json={"provider": "google"})
    assert r.status_code == 409
    assert r.json()["code"] == "not_configured"
    assert c.get("/api/storage").json()["providers"][0]["configured"] is False


def test_proveedor_desconocido_es_422(api):
    c, _, _, _, _ = api
    r = c.post("/api/storage/connect", json={"provider": "dropbox"})
    assert r.status_code == 422


def test_cancel_devuelve_cancelled(api):
    c, _, _, _, browser = api
    browser.delay = 5.0  # el usuario nunca vuelve
    c.post("/api/storage/connect", json={"provider": "google"})
    r = c.post("/api/storage/connect/cancel")
    assert r.status_code == 200
    assert r.json()["state"] == "cancelled"


# ----------------------------------------------------------------------- use
def test_use_cambia_entre_local_y_google(api):
    c, _, _, _, _ = api
    c.post("/api/storage/connect", json={"provider": "google"})
    _wait_connected(c)
    r = c.post("/api/storage/use", json={"provider": "local"})
    assert r.status_code == 200
    assert r.json()["active"] == "local"
    r = c.post("/api/storage/use", json={"provider": "google"})
    assert r.json()["active"] == "google"


def test_use_google_sin_conectar_es_409(api):
    c, _, _, _, _ = api
    r = c.post("/api/storage/use", json={"provider": "google"})
    assert r.status_code == 409
    assert r.json()["code"] == "not_connected"


# ----------------------------------------------------------------- disconnect
def test_disconnect_vuelve_a_local(api):
    c, _, store, _, _ = api
    c.post("/api/storage/connect", json={"provider": "google"})
    _wait_connected(c)
    r = c.post("/api/storage/disconnect", json={"provider": "google"})
    assert r.status_code == 200
    body = r.json()
    assert body["active"] == "local"
    assert body["providers"][0]["connected"] is False
    assert store.load("google") is None
