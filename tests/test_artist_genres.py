"""Generos de UN artista: `recommend.artist_genres` y GET /api/artist/genres.

OFFLINE. La ruta lee las mismas fichas que Discover y nunca arranca el
enricher: ningun test toca la red.
"""
from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from backend.app import main
from backend.app.main import create_app
from backend.app.recommend import artist_genres
from backend.app.storage import set_storage
from backend.app.storage.local import LocalStorage

T0 = 1_772_000_000.0


def _record(name: str, genres=None, status: str = "ok") -> dict:
    return {"name": name, "mbid": f"m-{name}", "genres": genres or [],
            "similar": [], "fetched_at": T0, "status": status}


# ------------------------------------------------------------------ pura
def test_reparte_el_peso_segun_el_count_y_normaliza_a_uno():
    records = {"nick cave": _record("Nick Cave", [["rock", 6], ["blues", 2],
                                                  ["punk", 2]])}
    out = artist_genres("Nick Cave", records)
    assert [g["name"] for g in out] == ["rock", "blues", "punk"]
    assert out[0]["share"] == pytest.approx(0.6)
    assert sum(g["share"] for g in out) == pytest.approx(1.0)


def test_un_credito_de_colaboracion_junta_a_sus_artistas():
    records = {
        "nick cave": _record("Nick Cave", [["rock", 3], ["blues", 1]]),
        "the bad seeds": _record("The Bad Seeds", [["rock", 1], ["punk", 1]]),
    }
    out = {g["name"]: g["share"]
           for g in artist_genres("Nick Cave & The Bad Seeds", records)}
    # rock: 0.75 + 0.5, blues: 0.25, punk: 0.5 -> sobre 2.0
    assert out == pytest.approx({"rock": 0.625, "punk": 0.25, "blues": 0.125})


def test_la_busqueda_pliega_mayusculas_y_tildes():
    records = {"rosalia": _record("Rosalía", [["flamenco", 4]])}
    assert artist_genres("  ROSALÍA ", records)[0]["name"] == "flamenco"
    assert artist_genres("Rosalía", records)[0]["share"] == pytest.approx(1.0)


@pytest.mark.parametrize("status", ["unknown", "error"])
def test_una_ficha_sin_generos_no_aporta(status):
    records = {"x": _record("X", [], status=status)}
    assert artist_genres("X", records) == []


def test_un_error_que_conserva_generos_viejos_si_cuenta():
    records = {"x": _record("X", [["jazz", 5]], status="error")}
    assert [g["name"] for g in artist_genres("X", records)] == ["jazz"]


def test_un_artista_sin_ficha_o_un_nombre_vacio_da_vacio():
    assert artist_genres("Nadie", {}) == []
    assert artist_genres("   ", {"x": _record("X", [["a", 1]])}) == []


def test_el_limite_es_seis_y_normaliza_sobre_los_que_quedan():
    genres = [[f"g{i}", 10 - i] for i in range(8)]
    out = artist_genres("X", {"x": _record("X", genres)})
    assert len(out) == 6
    assert sum(g["share"] for g in out) == pytest.approx(1.0)


def test_los_empates_se_ordenan_por_nombre():
    out = artist_genres("X", {"x": _record("X", [["b", 1], ["a", 1]])})
    assert [g["name"] for g in out] == ["a", "b"]


# ------------------------------------------------------------------ ruta
class SpyEnricher:
    def __init__(self) -> None:
        self.started = 0

    def ensure_started(self) -> None:
        self.started += 1

    def status(self) -> dict:
        return {}


@pytest.fixture
def api(tmp_path, monkeypatch):
    root = tmp_path / "lib"
    root.mkdir()
    storage = LocalStorage(root, device_id="d1")
    set_storage(storage)
    spy = SpyEnricher()
    monkeypatch.setattr(main, "_enricher", spy)
    try:
        with TestClient(create_app()) as client:
            yield client, storage, spy
    finally:
        set_storage(None)


def test_sin_nombre_da_422(api):
    client, _, _ = api
    assert client.get("/api/artist/genres").status_code == 422
    assert client.get("/api/artist/genres", params={"name": ""}).status_code == 422
    assert client.get("/api/artist/genres", params={"name": "  "}).status_code == 422


def test_un_artista_sin_perfil_da_vacio_y_no_arranca_el_perfilador(api):
    client, _, spy = api
    response = client.get("/api/artist/genres", params={"name": "Nadie"})
    assert response.status_code == 200
    assert response.json() == {"name": "Nadie", "genres": []}
    assert spy.started == 0


def test_devuelve_los_generos_guardados_con_shares_redondeados(api):
    client, storage, spy = api
    storage.save_artistinfo({
        "nick cave": _record("Nick Cave", [["post-punk", 3], ["rock", 2],
                                           ["blues", 2]])})
    body = client.get("/api/artist/genres",
                      params={"name": "Nick Cave & The Bad Seeds"}).json()
    assert body["name"] == "Nick Cave & The Bad Seeds"
    assert [g["name"] for g in body["genres"]] == ["post-punk", "blues", "rock"]
    assert body["genres"][0]["share"] == 0.429
    assert spy.started == 0


def test_una_segunda_llamada_sale_de_la_cache_compartida_con_discover(api):
    client, storage, _ = api
    storage.save_artistinfo({"x": _record("X", [["jazz", 2]])})
    loads = {"n": 0}
    original = storage.load_artistinfo

    def contando():
        loads["n"] += 1
        return original()

    storage.load_artistinfo = contando
    for _ in range(3):
        client.get("/api/artist/genres", params={"name": "X"})
    assert loads["n"] == 1


def test_prefiere_las_fichas_en_memoria_del_enricher(api, monkeypatch):
    client, storage, spy = api
    storage.save_artistinfo({"x": _record("X", [["jazz", 2]])})
    monkeypatch.setattr(spy, "records",
                        lambda: {"x": _record("X", [["pop", 2]])}, raising=False)
    body = client.get("/api/artist/genres", params={"name": "X"}).json()
    assert [g["name"] for g in body["genres"]] == ["pop"]


def test_si_no_se_pueden_leer_las_fichas_la_respuesta_es_vacia(api):
    client, storage, _ = api

    def roto():
        raise RuntimeError("Drive sin conexion")

    storage.load_artistinfo = roto
    response = client.get("/api/artist/genres", params={"name": "X"})
    assert response.status_code == 200 and response.json()["genres"] == []


def test_lee_las_fichas_que_guardo_otro_dispositivo_en_drive():
    import httpx
    from backend.app.cloud.drive import DriveStorage
    from fake_drive import FakeDrive

    class Tokens:
        def access_token(self) -> str:
            return "t"

        def invalidate(self) -> None:
            pass

    fake = FakeDrive()
    uno = DriveStorage(Tokens(), httpx.Client(transport=httpx.MockTransport(fake)),
                       "d1", sleep=lambda _s: None)
    uno.save_artistinfo({"x": _record("X", [["jazz", 3]])})
    otro = DriveStorage(Tokens(), httpx.Client(transport=httpx.MockTransport(fake)),
                        "d2", sleep=lambda _s: None)

    assert artist_genres("X", otro.load_artistinfo())[0]["name"] == "jazz"
