"""`/api/library` con el veredicto de cada archivo (join con `fileinfo`).

OFFLINE sobre un `LocalStorage` temporal. Un archivo sin registro sale con los
mismos bytes de siempre: ningun campo nuevo se emite sin dato.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from backend.app.downloader import library_scan
from backend.app.fileinfo import clean_record
from backend.app.main import create_app
from backend.app.storage import set_storage
from backend.app.storage.local import LocalStorage

CAMPOS_NUEVOS = {"verdict", "meta_src", "file_src", "real"}


@pytest.fixture
def api(tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    storage = LocalStorage(root, device_id="d1")
    set_storage(storage)
    try:
        with TestClient(create_app()) as client:
            yield client, root, storage
    finally:
        set_storage(None)


def _plantar(root: Path, key: str, size: int = 8) -> None:
    path = root / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)


def _registro(**over) -> dict:
    base = {"verdict": "match", "at": 1_760_000_000, "bytes": 8,
            "meta": "itunes", "file": "youtube"}
    base.update(over)
    return clean_record(base)


def _por_key(client) -> dict:
    return {f["key"]: f for f in client.get("/api/library").json()["files"]}


def test_un_archivo_viejo_sale_igual_que_hoy(api):
    client, root, _ = api
    _plantar(root, "A/a.mp3")
    _plantar(root, "A/a.jpg")

    body = client.get("/api/library").json()
    assert body["files"] == library_scan()
    assert not CAMPOS_NUEVOS & set(body["files"][0])


def test_con_registro_y_el_mismo_tamano_trae_veredicto_y_fuente(api):
    client, root, storage = api
    _plantar(root, "A/a.mp3")
    storage.save_fileinfo("A/a.mp3", _registro(meta="archive", file="archive"))

    fila = _por_key(client)["A/a.mp3"]
    assert fila["verdict"] == "match" and fila["meta_src"] == "archive"


def test_file_src_solo_cuando_difiere_de_la_ficha(api):
    client, root, storage = api
    _plantar(root, "A/a.mp3")
    _plantar(root, "A/b.mp3")
    storage.save_fileinfo("A/a.mp3", _registro(meta="archive", file="archive"))
    storage.save_fileinfo("A/b.mp3", _registro())

    filas = _por_key(client)
    assert "file_src" not in filas["A/a.mp3"]
    assert filas["A/b.mp3"]["file_src"] == "youtube"


def test_real_solo_para_parecido_y_no_coincide(api):
    client, root, storage = api
    for nombre, estado in (("p", "partial"), ("m", "mismatch"), ("c", "match")):
        _plantar(root, f"A/{nombre}.mp3")
        storage.save_fileinfo(f"A/{nombre}.mp3", _registro(
            verdict=estado, real="Numb (Live)", real_by="video"))

    filas = _por_key(client)
    assert filas["A/p.mp3"]["real"] == "Numb (Live)"
    assert filas["A/m.mp3"]["real"] == "Numb (Live)"
    assert "real" not in filas["A/c.mp3"]


def test_un_archivo_reemplazado_vuelve_a_ser_sin_verificar(api):
    client, root, storage = api
    _plantar(root, "A/a.mp3", size=8)
    storage.save_fileinfo("A/a.mp3", _registro(bytes=8))
    assert "verdict" in _por_key(client)["A/a.mp3"]

    _plantar(root, "A/a.mp3", size=20)  # otro contenido bajo la misma clave
    assert not CAMPOS_NUEVOS & set(_por_key(client)["A/a.mp3"])


def test_los_videos_tambien_traen_los_campos(api):
    client, root, storage = api
    _plantar(root, "A/v.mp4")
    storage.save_fileinfo("A/v.mp4", _registro())

    fila = _por_key(client)["A/v.mp4"]
    assert fila["kind"] == "video" and fila["verdict"] == "match"


def test_si_no_se_pueden_leer_los_registros_la_lista_sale_igual(api, monkeypatch):
    client, root, storage = api
    _plantar(root, "A/a.mp3")

    def roto():
        raise RuntimeError("Drive sin conexion")

    monkeypatch.setattr(storage, "load_fileinfo", roto)
    response = client.get("/api/library")
    assert response.status_code == 200
    assert response.json()["files"] == library_scan()


def test_el_join_no_cambia_lo_que_ve_library_scan(api):
    client, root, storage = api
    _plantar(root, "A/a.mp3")
    storage.save_fileinfo("A/a.mp3", _registro())
    antes = json.dumps(library_scan(), sort_keys=True)

    client.get("/api/library")
    assert json.dumps(library_scan(), sort_keys=True) == antes
    assert "verdict" not in library_scan()[0]
