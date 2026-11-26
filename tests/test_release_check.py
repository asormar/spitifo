"""Chequeo de la ultima release de Spitifo (release_check.py) y su ruta.

Todo OFFLINE. `latest_release` recibe un `httpx.Client`; los tests le pasan uno
con `httpx.MockTransport`, igual que test_ytdlp_update.py: `/releases/latest`
contesta 302 con el tag en el `Location`, sin API de GitHub.

Cubre:
- tag valido => version sin la "v" y url de esa release;
- sin redirect, tag con forma rara o error de red => version/url en None, sin
  lanzar;
- cache de 24 h: un segundo chequeo dentro de la ventana no vuelve a pedir;
  `force=True` si vuelve a pedir;
- la ruta /api/release/latest devuelve ese mismo payload y respeta `?force=1`.
"""
from __future__ import annotations

import httpx
import pytest

from backend.app import release_check


@pytest.fixture(autouse=True)
def _cache_limpia():
    """La cache en memoria no puede filtrar de un test al siguiente."""
    release_check.reset_cache()
    yield
    release_check.reset_cache()


def _github(*, location=None, tag_status=302, registro=None):
    """`MockTransport` que imita el redirect de `/releases/latest`."""
    def handler(request: httpx.Request) -> httpx.Response:
        if registro is not None:
            registro.append(request.url.path)
        if tag_status != 302:
            return httpx.Response(tag_status)
        destino = location if location is not None else "/asormar/spitifo/releases/tag/v0.2.0"
        return httpx.Response(302, headers={"location": destino})

    return httpx.MockTransport(handler)


def _client(transport) -> httpx.Client:
    return httpx.Client(transport=transport, follow_redirects=False)


def test_tag_valido_da_version_y_url():
    with _client(_github()) as client:
        payload = release_check.latest_release(client)
    assert payload == {
        "version": "0.2.0",
        "url": "https://github.com/asormar/spitifo/releases/tag/v0.2.0",
    }


def test_sin_redirect_no_rompe():
    with _client(_github(tag_status=200)) as client:
        payload = release_check.latest_release(client)
    assert payload == {"version": None, "url": None}


def test_tag_sin_forma_valida_se_descarta():
    with _client(_github(location="/asormar/spitifo/releases/tag/latest")) as client:
        payload = release_check.latest_release(client)
    assert payload == {"version": None, "url": None}


def test_location_sin_tag_se_descarta():
    with _client(_github(location="/asormar/spitifo")) as client:
        payload = release_check.latest_release(client)
    assert payload == {"version": None, "url": None}


def test_error_de_red_no_lanza():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sin red", request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        payload = release_check.latest_release(client)
    assert payload == {"version": None, "url": None}


def test_cache_24h_no_vuelve_a_pedir():
    registro: list[str] = []
    with _client(_github(registro=registro)) as client:
        release_check.latest_release(client)
        release_check.latest_release(client)
    assert len(registro) == 1


def test_force_ignora_la_cache():
    registro: list[str] = []
    with _client(_github(registro=registro)) as client:
        release_check.latest_release(client)
        release_check.latest_release(client, force=True)
    assert len(registro) == 2


def test_ruta_devuelve_el_payload(cliente, monkeypatch):
    monkeypatch.setattr(
        release_check, "latest_release",
        lambda client=None, force=False: {
            "version": "0.2.0" if not force else "0.3.0",
            "url": "https://github.com/asormar/spitifo/releases/tag/v0.2.0",
        })
    r = cliente.get("/api/release/latest")
    assert r.status_code == 200
    assert r.json()["version"] == "0.2.0"

    r_force = cliente.get("/api/release/latest?force=1")
    assert r_force.json()["version"] == "0.3.0"


def test_ruta_nunca_rompe_sin_internet(cliente, monkeypatch):
    monkeypatch.setattr(
        release_check, "latest_release",
        lambda client=None, force=False: {"version": None, "url": None})
    r = cliente.get("/api/release/latest")
    assert r.status_code == 200
    assert r.json() == {"version": None, "url": None}
