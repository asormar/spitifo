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


def _subidas(fake) -> int:
    """Escrituras de archivos chicos (indice, listas): toda subida a /upload."""
    return sum(1 for method, path in fake.calls
               if method in ("POST", "PATCH") and path.startswith("/upload/"))


def _papeleras(fake) -> int:
    return sum(1 for method, path in fake.calls
               if method == "PATCH" and not path.startswith("/upload/"))


def test_drive_un_tema_con_portadas_escribe_el_indice_dos_veces_y_no_las_listas(tmp_path):
    """Antes: una escritura del indice por archivo y otra de las listas (unos
    9,5 s en un telefono). Ahora: una por tanda (temas, portadas) y ninguna de
    listas si ninguna tiene el tema."""
    from backend.app.storage import set_storage as instalar

    fake, drive = _drive_storage(tmp_path)
    key = "A/A - Tema.mp3"
    items = []
    for nombre in ("A - Tema.mp3", "A - Tema.jpg", "A - Tema.s.jpg"):
        src = tmp_path / nombre
        src.write_bytes(DATA)
        items.append((f"A/{nombre}", src))
    drive.put_files(items)
    instalar(drive)
    try:
        with TestClient(create_app()) as c:
            fake.reset_calls()
            r = _borrar(c, [key])

        assert r.json() == {"deleted": [key], "failed": []}
        assert _papeleras(fake) == 3
        assert _subidas(fake) == 2
        assert [f.key for f in drive.list()] == []
    finally:
        set_storage(None)


def test_drive_un_album_escribe_el_indice_dos_veces(tmp_path):
    from backend.app.storage import set_storage as instalar

    fake, drive = _drive_storage(tmp_path)
    keys = []
    for i in range(12):
        src = tmp_path / f"t{i}.mp3"
        src.write_bytes(DATA)
        cover = tmp_path / f"t{i}.jpg"
        cover.write_bytes(DATA)
        drive.put_files([(f"A/Tema {i}.mp3", src), (f"A/Tema {i}.jpg", cover)])
        keys.append(f"A/Tema {i}.mp3")
    instalar(drive)
    try:
        with TestClient(create_app()) as c:
            fake.reset_calls()
            r = _borrar(c, keys)

        assert r.json() == {"deleted": keys, "failed": []}
        assert _papeleras(fake) == 24
        assert _subidas(fake) == 2
    finally:
        set_storage(None)


def test_drive_limpia_la_lista_que_tenia_el_tema(tmp_path):
    from backend.app.storage import set_storage as instalar

    fake, drive = _drive_storage(tmp_path)
    src = tmp_path / "x.mp3"
    src.write_bytes(DATA)
    drive.put_file("A/a.mp3", src)
    instalar(drive)
    try:
        with TestClient(create_app()) as c:
            assert c.put("/api/playlists/viaje", json={
                "name": "Viaje", "keys": ["A/a.mp3"]}).status_code == 200
            fake.reset_calls()
            assert _borrar(c, ["A/a.mp3"]).status_code == 200
            listas = c.get("/api/playlists").json()["playlists"]

        assert _subidas(fake) == 2  # el indice (sin portadas) y las listas
        assert listas[0]["keys"] == []
    finally:
        set_storage(None)


def test_drive_una_papelera_que_falla_no_frena_las_demas(tmp_path):
    fake, drive = _drive_storage(tmp_path)
    for nombre in ("bien", "mal"):
        src = tmp_path / f"{nombre}.mp3"
        src.write_bytes(DATA)
        drive.put_file(f"A/{nombre}.mp3", src)
    mal_id = next(fid for fid, f in fake.files.items() if f["name"] == "mal.mp3")
    real = drive._trash

    def trash(remote_id):
        if remote_id == mal_id:
            raise OSError("sin permiso")
        real(remote_id)

    drive._trash = trash
    failed = drive.delete_files(["A/bien.mp3", "A/mal.mp3", "A/nada.mp3"])

    assert set(failed) == {"A/mal.mp3", "A/nada.mp3"}
    assert isinstance(failed["A/nada.mp3"], FileNotFoundError)
    assert "sin permiso" in str(failed["A/mal.mp3"])
    assert [f.key for f in drive.list()] == ["A/mal.mp3"]
