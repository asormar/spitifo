"""Tests OFFLINE del ConnectFlow (backend/app/cloud/connect.py).

El navegador es un doble que pega de verdad en el loopback (`127.0.0.1`, que es
local) con el `state` y el `code`; el canje de tokens usa `httpx.MockTransport`.
Nada sale a internet y nunca se abre un navegador real.
"""
from __future__ import annotations

import threading
import time
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from backend.app.cloud import oauth
from backend.app.cloud.connect import ConnectFlow, disconnect, is_connected
from backend.app.cloud.oauth import OAuthNotConfigured
from backend.app.cloud.tokens import PlainProtector, TokenStore


@pytest.fixture(autouse=True)
def google_env(monkeypatch, tmp_path):
    """Cliente de Google por entorno y sin leer un `oauth_clients.json` real."""
    monkeypatch.setenv("SPITIFO_GOOGLE_CLIENT_ID", "gid")
    monkeypatch.setenv("SPITIFO_GOOGLE_CLIENT_SECRET", "gsecret")
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(oauth, "BUNDLED_CONFIG", tmp_path / "nada.json")


@pytest.fixture
def store(tmp_path) -> TokenStore:
    return TokenStore(tmp_path / "tokens", PlainProtector())


def _token_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={
        "access_token": "at", "refresh_token": "rt",
        "expires_in": 3600, "scope": "s"})


def _client_factory() -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(_token_handler),
                        timeout=5.0)


class FakeBrowser:
    """Doble del navegador: parsea la URL y vuelve al redirect del loopback.

    En un thread para no bloquear `start`, igual que un navegador real. `state`
    o `error` permiten simular un redirect manipulado o un "Cancelar".
    """

    def __init__(self, *, code: str = "CODE", state: str | None = None,
                 error: str | None = None, delay: float = 0.05) -> None:
        self.code = code
        self.state = state
        self.error = error
        self.delay = delay
        self.urls: list[str] = []

    def __call__(self, url: str) -> None:
        self.urls.append(url)
        query = parse_qs(urlparse(url).query)
        redirect = query["redirect_uri"][0]
        state = self.state or query["state"][0]
        if self.error:
            target = f"{redirect}?state={state}&error={self.error}"
        else:
            target = f"{redirect}?state={state}&code={self.code}"

        def _go() -> None:
            if self.delay:
                time.sleep(self.delay)
            try:
                httpx.get(target, timeout=5.0)
            except Exception:
                # El receptor puede estar cerrado (start dos veces): da igual.
                pass

        threading.Thread(target=_go, daemon=True).start()


def _no_browser(url: str) -> None:
    """El usuario nunca vuelve: sirve para timeout y cancelar."""


def _wait(flow: ConnectFlow, state: str, timeout: float = 8.0) -> None:
    limite = time.monotonic() + timeout
    while time.monotonic() < limite:
        if flow.status()["state"] == state:
            return
        time.sleep(0.01)
    raise AssertionError(f"nunca llego a {state!r}: {flow.status()}")


# ------------------------------------------------------------------ flujo feliz
def test_start_va_de_pending_a_connected(store):
    browser = FakeBrowser()
    conectados: list[str] = []
    flow = ConnectFlow(store, browser=browser, client_factory=_client_factory,
                       on_connected=conectados.append)

    url = flow.start("google")
    assert url.startswith(oauth.GOOGLE_AUTHORIZE_URL)
    assert flow.status()["state"] == "pending"
    assert flow.status()["provider"] == "google"

    _wait(flow, "connected")
    assert conectados == ["google"]
    assert flow.status()["error"] is None
    tokens = store.load("google")
    assert tokens is not None
    assert tokens.access_token == "at"
    assert tokens.refresh_token == "rt"


# ------------------------------------------------------------------ fallos
def test_state_incorrecto_es_error(store):
    flow = ConnectFlow(store, browser=FakeBrowser(state="otro"),
                       client_factory=_client_factory)
    flow.start("google")
    _wait(flow, "error")
    assert flow.status()["error"] == "Sign-in failed"
    assert store.load("google") is None


def test_access_denied_es_error_humano(store):
    flow = ConnectFlow(store, browser=FakeBrowser(error="access_denied"),
                       client_factory=_client_factory)
    flow.start("google")
    _wait(flow, "error")
    assert flow.status()["error"] == "Sign-in was cancelled"


def test_timeout_es_error(store):
    flow = ConnectFlow(store, browser=_no_browser,
                       client_factory=_client_factory, timeout=0.2)
    flow.start("google")
    _wait(flow, "error")
    assert flow.status()["error"] == "Timed out waiting for the browser"


def test_start_sin_configuracion_propaga(store, monkeypatch):
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_SECRET", raising=False)
    flow = ConnectFlow(store, browser=_no_browser,
                       client_factory=_client_factory)
    with pytest.raises(OAuthNotConfigured):
        flow.start("google")
    assert flow.status()["state"] == "idle"


# ------------------------------------------------------------------ cancelar
def test_cancel_deja_cancelled(store):
    flow = ConnectFlow(store, browser=_no_browser,
                       client_factory=_client_factory)
    flow.start("google")
    flow.cancel()
    assert flow.status()["state"] == "cancelled"


def test_cancel_sin_flujo_no_cambia_el_estado(store):
    flow = ConnectFlow(store, browser=_no_browser,
                       client_factory=_client_factory)
    flow.cancel()
    assert flow.status()["state"] == "idle"


def test_start_dos_veces_cancela_el_primero(store):
    """Un `start` nuevo cierra al anterior; solo el ultimo conecta."""
    browser = FakeBrowser(delay=0.3)
    conectados: list[str] = []
    flow = ConnectFlow(store, browser=browser, client_factory=_client_factory,
                       on_connected=conectados.append)

    url1 = flow.start("google")
    url2 = flow.start("google")
    assert url1 != url2
    # El segundo flujo manda: el estado es pending, no connected por el primero.
    assert flow.status()["state"] == "pending"

    primero = urlparse(parse_qs(urlparse(url1).query)["redirect_uri"][0])
    segundo = urlparse(parse_qs(urlparse(url2).query)["redirect_uri"][0])
    if primero.port != segundo.port:
        # El primer receptor quedo cerrado de verdad.
        with pytest.raises(httpx.HTTPError):
            httpx.get(f"{primero.geturl()}?state=x&code=y", timeout=2.0)

    _wait(flow, "connected")
    # El redirect viejo no disparo una segunda conexion.
    assert conectados == ["google"]


# ------------------------------------------------------------------ helpers
def test_is_connected_y_disconnect(store):
    assert is_connected(store, "google") is False
    store.save("google", oauth.TokenSet("at", "rt", time.time() + 3600))
    assert is_connected(store, "google") is True
    disconnect(store, "google")
    assert is_connected(store, "google") is False


def test_is_connected_false_sin_configuracion(store, monkeypatch):
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_SECRET", raising=False)
    store.save("google", oauth.TokenSet("at", None, time.time() + 10))
    assert is_connected(store, "google") is False
