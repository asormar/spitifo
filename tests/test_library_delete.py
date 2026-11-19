"""Borrado desde la biblioteca: POST /api/library/delete.

Todo OFFLINE: el adapter local sobre una carpeta temporal y el de Drive sobre
el Drive falso. Cubre archivos, portadas compartidas, listas, validacion,
fallos parciales y el listado posterior.
"""
from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from backend.app.main import create_app
from backend.app.storage import get_storage, set_storage
from backend.app.storage.local import LocalStorage

DATA = b"0123456789"


@pytest.fixture
def api(tmp_path):
    """TestClient con una biblioteca local temporal; devuelve (cliente, raiz)."""
    root = tmp_path / "lib"
    root.mkdir()
    set_storage(LocalStorage(root))
    try:
        with TestClient(create_app()) as c:
            yield c, root
    finally:
        set_storage(None)


def _plantar(root: Path, key: str, data: bytes = DATA) -> Path:
    p = root / key
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return p


def _borrar(c, keys):
    return c.post("/api/library/delete", json={"keys": keys})


# ------------------------------------------------------------------ archivos
def test_borra_archivo_y_las_dos_portadas(api):
    c, root = api
    _plantar(root, "A/A - Tema.mp3")
    _plantar(root, "A/A - Tema.jpg")
    _plantar(root, "A/A - Tema.s.jpg")
    _plantar(root, "A/Otro.mp3")

    r = _borrar(c, ["A/A - Tema.mp3"])

    assert r.status_code == 200
    assert r.json() == {"deleted": ["A/A - Tema.mp3"], "failed": []}
    for nombre in ("A - Tema.mp3", "A - Tema.jpg", "A - Tema.s.jpg"):
        assert not (root / "A" / nombre).exists()
    assert (root / "A" / "Otro.mp3").exists()


def test_avisa_a_android_de_todo_lo_borrado_sin_marcar_actividad(api, monkeypatch):
    from backend.app import activity
    c, root = api
    _plantar(root, "A/A - Tema.mp3")
    _plantar(root, "A/A - Tema.jpg")
    avisos: list[list[str]] = []
    ocupado: list[bool] = []
    monkeypatch.setattr(activity, "_removed_listeners", [avisos.append])
    monkeypatch.setattr(activity, "_listeners", [ocupado.append])

    assert _borrar(c, ["A/A - Tema.mp3"]).status_code == 200

    # Audio y portada; nunca el aviso de descarga (mostraria su notificacion).
    assert avisos == [["A/A - Tema.mp3", "A/A - Tema.jpg"]]
    assert ocupado == []


def test_un_borrado_que_el_sistema_ignora_se_informa_como_fallo(api, monkeypatch):
    # Android (FUSE) puede "aceptar" el unlink de un archivo de otra app sin
    # borrarlo. Si el nombre sigue en la carpeta, el borrado fallo.
    c, root = api
    _plantar(root, "A/A - Tema.mp3")
    monkeypatch.setattr(Path, "unlink", lambda self, missing_ok=False: None)

    r = _borrar(c, ["A/A - Tema.mp3"])

    assert r.status_code == 200
    assert r.json()["deleted"] == []
    assert [f["key"] for f in r.json()["failed"]] == ["A/A - Tema.mp3"]


def test_la_portada_sobrevive_si_queda_un_video_del_mismo_tronco(api):
    c, root = api
    for nombre in ("A - Tema.mp3", "A - Tema.mp4", "A - Tema.jpg", "A - Tema.s.jpg"):
        _plantar(root, f"A/{nombre}")

    r = _borrar(c, ["A/A - Tema.mp3"])

    assert r.status_code == 200
    assert (root / "A" / "A - Tema.mp4").exists()
    assert (root / "A" / "A - Tema.jpg").exists()
    assert (root / "A" / "A - Tema.s.jpg").exists()


def test_borrar_audio_y_video_juntos_si_saca_las_portadas(api):
    c, root = api
    for nombre in ("A - Tema.mp3", "A - Tema.mp4", "A - Tema.jpg", "A - Tema.s.jpg"):
        _plantar(root, f"A/{nombre}")

    r = _borrar(c, ["A/A - Tema.mp3", "A/A - Tema.mp4"])

    assert r.status_code == 200
    assert set(r.json()["deleted"]) == {"A/A - Tema.mp3", "A/A - Tema.mp4"}
    for nombre in ("A - Tema.mp3", "A - Tema.mp4", "A - Tema.jpg", "A - Tema.s.jpg"):
        assert not (root / "A" / nombre).exists()


def test_borrar_ignora_una_portada_que_ya_no_esta(api):
    c, root = api
    _plantar(root, "A/A - Tema.mp3")

    r = _borrar(c, ["A/A - Tema.mp3"])

    assert r.status_code == 200
    assert r.json()["failed"] == []


# ------------------------------------------------------------------ listas
def test_las_listas_pierden_la_clave_y_se_quedan(api):
    c, root = api
    _plantar(root, "A/a.mp3")
    _plantar(root, "A/b.mp3")
    assert c.put("/api/playlists/viaje", json={
        "name": "Viaje", "keys": ["A/a.mp3", "A/b.mp3"]}).status_code == 200
    assert c.put("/api/playlists/sola", json={
        "name": "Sola", "keys": ["A/a.mp3"]}).status_code == 200

    r = _borrar(c, ["A/a.mp3"])
    assert r.status_code == 200

    listas = {p["id"]: p for p in c.get("/api/playlists").json()["playlists"]}
    assert set(listas) == {"viaje", "sola"}  # ninguna se borra
    assert listas["viaje"]["keys"] == ["A/b.mp3"]
    assert listas["sola"]["keys"] == []


# --------------------------------------------------------------- validacion
@pytest.mark.parametrize("keys", [
    ["../secreto.mp3"],
    ["/etc/passwd.mp3"],
    ["a\\b.mp3"],
    ["A/../secreto.mp3"],
    ["A/notas.txt"],
    ["A/portada.jpg"],
    [],
])
def test_claves_invalidas_se_rechazan(api, keys):
    c, root = api
    assert _borrar(c, keys).status_code == 422
    # Nada de lo que habia se toco.
    _plantar(root, "A/ok.mp3")
    assert c.get("/api/library").json()["count"] == 1


def test_demasiadas_claves_se_rechazan(api):
    c, _root = api
    assert _borrar(c, [f"A/x{i}.mp3" for i in range(501)]).status_code == 422


# ------------------------------------------------------------ fallos parciales
def test_un_fallo_no_cancela_los_demas(api, monkeypatch):
    c, root = api
    _plantar(root, "A/bien.mp3")
    _plantar(root, "A/mal.mp3")
    storage = get_storage()
    real = storage.delete

    def delete(key):
        if key.endswith("mal.mp3"):
            raise OSError("disco de solo lectura")
        return real(key)

    monkeypatch.setattr(storage, "delete", delete)

    r = _borrar(c, ["A/bien.mp3", "A/mal.mp3"])

    assert r.status_code == 200
    data = r.json()
    assert data["deleted"] == ["A/bien.mp3"]
    assert len(data["failed"]) == 1
    assert data["failed"][0]["key"] == "A/mal.mp3"
    assert "solo lectura" in data["failed"][0]["error"]
    assert not (root / "A" / "bien.mp3").exists()
    assert (root / "A" / "mal.mp3").exists()


def test_el_listado_ya_no_devuelve_la_clave(api):
    c, root = api
    _plantar(root, "A/a.mp3")
    _plantar(root, "A/b.mp3")

    assert c.get("/api/library").json()["count"] == 2
    assert _borrar(c, ["A/a.mp3"]).status_code == 200

    files = c.get("/api/library").json()["files"]
    assert {f["key"] for f in files} == {"A/b.mp3"}


# --------------------------------------------------------------------- Drive
class _FakeTokens:
    def access_token(self) -> str:
        return "test-token"

    def invalidate(self) -> None:
        pass


def _drive_storage(tmp_path: Path):
    from fake_drive import FakeDrive
    from backend.app.cloud.cache import AudioCache
    from backend.app.cloud.drive import DriveStorage

    fake = FakeDrive()
    client = httpx.Client(transport=httpx.MockTransport(fake))
    cache = AudioCache(tmp_path / "cache", budget_bytes=256 * 1024 * 1024)
    storage = DriveStorage(_FakeTokens(), client, "borrado", cache=cache,
                           sleep=lambda _s: None)
    return fake, storage


def test_drive_borra_con_tombstone_y_papelera(tmp_path):
    from backend.app.storage import set_storage as instalar

    fake, drive = _drive_storage(tmp_path)
    src = tmp_path / "x.mp3"
    src.write_bytes(DATA)
    key = "A/A - Tema.mp3"
    drive.put_file(key, src)
    instalar(drive)
    try:
        with TestClient(create_app()) as c:
            r = _borrar(c, [key])

        assert r.status_code == 200
        assert r.json() == {"deleted": [key], "failed": []}
        assert [f.key for f in drive.list()] == []
        trashed = [f for f in fake.files.values() if f["trashed"]]
        assert len(trashed) == 1  # el archivo remoto fue a la papelera
    finally:
        set_storage(None)
