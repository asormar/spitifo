"""Rutas de Discover: GET /api/discover y POST /api/discover/dismiss.

El enricher se reemplaza por un doble: ninguna request de estos tests toca la
red ni arranca el hilo de verdad.
"""
from __future__ import annotations

import json
import time

import pytest
from starlette.testclient import TestClient

from backend.app import main
from backend.app.discover import discover_file
from backend.app.main import create_app
from backend.app.storage import set_storage
from backend.app.storage.local import STATE_DIR, LocalStorage

T0 = 1_772_000_000.0


class SlowStorage(LocalStorage):
    """LocalStorage con retardo en cada lectura, como Drive.

    Si Discover no cachea los insumos, cada GET paga `delay` cuatro veces.
    """

    delay = 0.2

    def _slow(self) -> None:
        time.sleep(self.delay)

    def list(self):
        self._slow()
        return super().list()

    def load_artistinfo(self) -> dict:
        self._slow()
        return super().load_artistinfo()

    def load_discover(self):
        self._slow()
        return super().load_discover()

    def load_listens_summary(self) -> dict:
        self._slow()
        return super().load_listens_summary()



def _record(name: str, *, genres: list | None = None,
            similar: list | None = None) -> dict:
    return {"name": name, "mbid": f"m-{name}", "genres": genres or [],
            "similar": similar or [], "fetched_at": T0, "status": "ok"}


class FakeEnricher:
    """Doble con los contadores fijos y sin hilo."""

    def __init__(self) -> None:
        self.started = 0
        self.fail = False
        self._status = {"done": 2, "total": 5, "running": True,
                        "offline": False}

    def ensure_started(self) -> None:
        self.started += 1
        if self.fail:
            raise RuntimeError("boom")

    def status(self) -> dict:
        return dict(self._status)


@pytest.fixture
def api(tmp_path, monkeypatch):
    root = tmp_path / "lib"
    root.mkdir()
    storage = LocalStorage(root, device_id="d1")
    set_storage(storage)
    fake = FakeEnricher()
    monkeypatch.setattr(main, "_enricher", fake)
    try:
        with TestClient(create_app()) as client:
            yield client, storage, fake
    finally:
        set_storage(None)


def _write_track(root, key: str) -> None:
    """Archivo con extension de audio pero sin tags: la clave manda."""
    path = root / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"no es audio")


def _seed(storage) -> None:
    _write_track(storage.root, "Alfa/Alfa - Uno.mp3")
    storage.save_artistinfo({
        "alfa": _record("Alfa", genres=[["rock", 3]], similar=[
            {"name": "X", "mbid": "m-X", "score": 1.0}]),
        "x": _record("X", genres=[["indie", 2]]),
    })


# ------------------------------------------------------------------- GET
def test_get_discover_con_biblioteca_vacia(api):
    client, _, fake = api
    response = client.get("/api/discover")
    assert response.status_code == 200
    assert response.json() == {"status": fake.status(), "genres": [],
                               "artists": []}
    assert fake.started == 1


def test_get_discover_arma_generos_y_candidatos(api):
    client, storage, fake = api
    _seed(storage)

    body = client.get("/api/discover").json()
    assert body["status"] == fake.status()
    assert body["genres"] == [{"name": "rock", "share": 1.0}]
    assert body["artists"] == [{
        "name": "X", "mbid": "m-X", "score": 1.0,
        "because": ["Alfa"], "genres": ["indie"],
    }]
    assert fake.started == 1


def test_get_discover_sigue_si_el_enricher_falla(api):
    client, _, fake = api
    fake.fail = True
    response = client.get("/api/discover")
    assert response.status_code == 200
    assert response.json()["artists"] == []


def test_get_discover_prefiere_las_fichas_del_enricher(api, monkeypatch):
    client, storage, fake = api
    _seed(storage)  # el storage dice "rock" y el candidato X
    monkeypatch.setattr(fake, "records", lambda: {
        "alfa": _record("Alfa", genres=[["pop", 5]], similar=[
            {"name": "Y", "mbid": "m-Y", "score": 1.0}]),
        "y": _record("Y", genres=[["pop", 1]]),
    }, raising=False)

    body = client.get("/api/discover").json()
    assert body["genres"] == [{"name": "pop", "share": 1.0}]
    assert [artist["name"] for artist in body["artists"]] == ["Y"]


def test_get_discover_arranca_el_enricher_en_cada_request(api):
    client, _, fake = api
    client.get("/api/discover")
    client.get("/api/discover")
    assert fake.started == 2


def test_get_discover_repetido_sale_de_la_cache(tmp_path, monkeypatch):
    root = tmp_path / "lib"
    root.mkdir()
    storage = SlowStorage(root, device_id="d1")
    set_storage(storage)
    monkeypatch.setattr(main, "_enricher", FakeEnricher())
    try:
        with TestClient(create_app()) as client:
            _seed(storage)
            client.get("/api/discover")
            started = time.perf_counter()
            body = client.get("/api/discover").json()
            elapsed = time.perf_counter() - started
    finally:
        set_storage(None)
    assert [artist["name"] for artist in body["artists"]] == ["X"]
    assert elapsed < 0.05, f"el GET repetido tardo {elapsed:.3f} s"


# --------------------------------------------------------------- dismiss
def test_dismiss_saca_al_artista_y_undo_lo_devuelve(api):
    client, storage, _ = api
    _seed(storage)
    assert [a["name"] for a in client.get("/api/discover").json()["artists"]]

    response = client.post("/api/discover/dismiss", json={"name": "X"})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert storage.load_discover().dismissed_set() == {"x"}
    assert client.get("/api/discover").json()["artists"] == []

    path = storage.root / STATE_DIR / discover_file("d1")
    payload = json.loads(path.read_bytes())
    assert payload["dismissed"]["x"]["undone"] is False

    response = client.post("/api/discover/dismiss",
                           json={"name": "x", "undo": True})
    assert response.status_code == 200
    assert storage.load_discover().dismissed_set() == set()
    assert [a["name"] for a in
            client.get("/api/discover").json()["artists"]] == ["X"]


def test_dismiss_usa_el_nombre_plegado_para_el_match(api):
    client, storage, _ = api
    _seed(storage)
    client.post("/api/discover/dismiss", json={"name": "  X  "})
    assert storage.load_discover().dismissed_set() == {"x"}
    assert client.get("/api/discover").json()["artists"] == []


@pytest.mark.parametrize("body", [
    {},
    {"name": None},
    {"name": 3},
    {"name": ""},
    {"name": "   "},
    {"name": "x" * 201},
    {"name": "X", "undo": "si"},
    {"name": "X", "undo": 1},
])
def test_dismiss_invalido_da_422(api, body):
    client, _, _ = api
    response = client.post("/api/discover/dismiss", json=body)
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"]


def test_dismiss_con_cuerpo_que_no_es_objeto_da_422(api):
    client, _, _ = api
    response = client.post("/api/discover/dismiss", json=["X"])
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body"]


def test_dismiss_con_json_roto_da_422(api):
    client, _, _ = api
    response = client.post("/api/discover/dismiss", content=b"{",
                           headers={"content-type": "application/json"})
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "JSON decode error"


def test_dismiss_sobre_varios_artistas_los_guarda_todos(api):
    client, storage, _ = api
    for name in ("Uno", "Dos"):
        assert client.post("/api/discover/dismiss",
                           json={"name": name}).status_code == 200
    assert storage.load_discover().dismissed_set() == {"uno", "dos"}
