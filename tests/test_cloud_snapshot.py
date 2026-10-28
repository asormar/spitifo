"""Tests OFFLINE de la copia local de archivos chicos (`cloud/snapshot.py`).

Un "proceso nuevo" es un `DriveStorage` nuevo con un `SmallFileSnapshot` nuevo
sobre la MISMA carpeta: no comparten nada en memoria, solo lo que quedo en disco.
Todo pasa por el Drive falso (`tests/fake_drive.py`) y `httpx.MockTransport`.
"""
from __future__ import annotations

import json
import os
import threading

import httpx
import pytest

from backend.app.cloud.drive import DriveStorage
from backend.app.cloud.library_index import LibraryIndex
from backend.app.cloud.snapshot import SmallFileSnapshot
from fake_drive import FakeDrive


class _Tokens:
    def access_token(self) -> str:
        return "token-secreto-de-prueba"

    def invalidate(self) -> None:
        pass


def _storage(fake, snap_dir, device_id="devA", *, snapshot=True,
             sleep=None) -> DriveStorage:
    """Un proceso nuevo: cliente, storage y copia local recien armados."""
    client = httpx.Client(transport=httpx.MockTransport(fake))
    snap = SmallFileSnapshot(snap_dir) if snapshot else None
    kwargs = {"sleep": sleep} if sleep is not None else {}
    return DriveStorage(_Tokens(), client, device_id, snapshot=snap, **kwargs)


def _put(storage, tmp_path, key, data=b"x") -> str:
    src = tmp_path / f"src-{os.urandom(4).hex()}.mp3"
    src.write_bytes(data)
    storage.put_file(key, src)
    return key


def _downloads(fake) -> list[str]:
    """Paths de las descargas `alt=media` de archivos chicos hechas hasta ahora."""
    return [path for method, path in fake.calls
            if method == "GET" and path.startswith("/drive/v3/files/")]


def _id_of(fake, name) -> str:
    return next(fid for fid, f in fake.files.items() if f["name"] == name)


def _touch(fake, name, data) -> None:
    """Cambia el contenido remoto como lo haria otro dispositivo: sube la version."""
    f = fake.files[_id_of(fake, name)]
    f["data"] = data
    f["version"] += 1


def _seed_devices(fake, tmp_path, names=("devA", "devB", "devC")) -> None:
    """Cada dispositivo publica un tema; el snapshot de la semilla se descarta."""
    for i, name in enumerate(names):
        storage = _storage(fake, tmp_path / f"seed-{name}", name)
        _put(storage, tmp_path, f"{name}/tema-{i}.mp3", b"x" * (i + 1))


# ------------------------------------------------------------- reuso de bytes
def test_un_proceso_nuevo_no_baja_lo_que_no_cambio(tmp_path):
    fake = FakeDrive()
    _seed_devices(fake, tmp_path)
    snap = tmp_path / "snap"

    primero = _storage(fake, snap, "devD")
    fake.reset_calls()
    keys = [f.key for f in primero.list()]
    assert len(keys) == 3
    assert len(_downloads(fake)) == 3  # sin copia previa: baja los 3 indices

    segundo = _storage(fake, snap, "devD")
    fake.reset_calls()
    assert [f.key for f in segundo.list()] == keys
    assert _downloads(fake) == [], "nada cambio: ni un solo indice se vuelve a bajar"
    # Solo queda el listado: ni siquiera se busca de nuevo la carpeta Spitifo.
    assert fake.calls == [("GET", "/drive/v3/files")]


def test_un_modifiedtime_nuevo_baja_solo_ese_archivo(tmp_path):
    fake = FakeDrive()
    _seed_devices(fake, tmp_path)
    snap = tmp_path / "snap"
    _storage(fake, snap, "devD").list()

    # Otro dispositivo publica: SOLO index-devB.json cambia.
    otro = _storage(fake, tmp_path / "otro", "devB")
    _put(otro, tmp_path, "devB/nuevo.mp3", b"nuevo")
    changed = _id_of(fake, "index-devB.json")

    proceso = _storage(fake, snap, "devD")
    fake.reset_calls()
    keys = {f.key for f in proceso.list()}
    assert "devB/nuevo.mp3" in keys
    assert _downloads(fake) == [f"/drive/v3/files/{changed}"]


def test_el_cambio_se_detecta_aunque_modifiedtime_coincida(tmp_path):
    """El fake redondea al segundo: `version` y `size` desempatan."""
    fake = FakeDrive()
    _seed_devices(fake, tmp_path, ("devA",))
    snap = tmp_path / "snap"
    assert len(_storage(fake, snap, "devD").list()) == 1

    # Mismo modifiedTime (no se toca), version nueva: el contenido cambio.
    index = LibraryIndex.from_bytes(fake.data_of(_id_of(fake, "index-devA.json")))
    index.entries.clear()
    _touch(fake, "index-devA.json", index.to_bytes())

    assert _storage(fake, snap, "devD").list() == []


def test_los_archivos_quitados_salen_de_la_copia(tmp_path):
    fake = FakeDrive()
    _seed_devices(fake, tmp_path)
    snap = tmp_path / "snap"
    _storage(fake, snap, "devD").list()
    names = {e["name"] for e in SmallFileSnapshot(snap).entries().values()}
    assert names == {"index-devA.json", "index-devB.json", "index-devC.json"}

    fake.files[_id_of(fake, "index-devB.json")]["trashed"] = True
    storage = _storage(fake, snap, "devD")
    assert {f.key.split("/")[0] for f in storage.list()} == {"devA", "devC"}

    names = {e["name"] for e in SmallFileSnapshot(snap).entries().values()}
    assert names == {"index-devA.json", "index-devC.json"}
    assert not any(p.suffix == ".bin" and p.stat().st_size == 0
                   for p in snap.rglob("*.bin"))
    assert len(list((snap / "files").glob("*.bin"))) == 2


# ------------------------------------------------------------------ paralelo
def test_las_descargas_corren_en_paralelo_y_el_merge_es_el_mismo(tmp_path):
    fake = FakeDrive()
    _seed_devices(fake, tmp_path, ("devA", "devB", "devC", "devD"))
    seen = {"now": 0, "max": 0}
    lock = threading.Lock()
    barrier = threading.Barrier(2, timeout=5)

    def on_download(_file_id):
        with lock:
            seen["now"] += 1
            seen["max"] = max(seen["max"], seen["now"])
        try:
            barrier.wait()  # solo pasa si hay otra descarga en vuelo a la vez
        except threading.BrokenBarrierError:
            pass
        finally:
            with lock:
                seen["now"] -= 1

    fake.on_download = on_download
    storage = _storage(fake, tmp_path / "snap", "devE", snapshot=False)
    listed = storage.list()
    assert seen["max"] >= 2, "los indices se bajaron de a uno"

    # Referencia secuencial: merge en el orden del listado, sin copia ni threads.
    merged = LibraryIndex()
    for fid, f in fake.files.items():
        if f["name"].startswith("index-"):
            merged = merged.merge(LibraryIndex.from_bytes(f["data"]))
    assert [f.key for f in listed] == sorted(e.key for e in merged.live())
    assert {f.key: f.size for f in listed} == {
        e.key: e.size for e in merged.live()}


def test_un_fallo_de_red_en_un_archivo_no_tira_la_biblioteca(tmp_path):
    fake = FakeDrive()
    _seed_devices(fake, tmp_path)
    broken = _id_of(fake, "index-devB.json")
    base = fake  # el handler original

    def handler(request):
        if request.url.path.endswith(f"/{broken}"):
            return httpx.Response(500)
        return base._route(request)

    fake.fail_with = handler
    storage = _storage(fake, tmp_path / "snap", "devD",
                       sleep=lambda _s: None)
    assert {f.key.split("/")[0] for f in storage.list()} == {"devA", "devC"}


# ------------------------------------------------------ carpetas cacheadas
def test_la_carpeta_cacheada_se_reusa_en_el_proceso_siguiente(tmp_path):
    fake = FakeDrive()
    snap = tmp_path / "snap"
    a = _storage(fake, snap, "devA")
    _put(a, tmp_path, "Artista/uno.mp3")
    state = json.loads((snap / "state.json").read_text("utf-8"))
    assert set(state["folders"]) >= {"", "Artista"}

    b = _storage(fake, snap, "devA")
    fake.reset_calls()
    b.list()
    # El id de `Spitifo` no se busca: un solo GET (el listado de indices).
    assert fake.calls == [("GET", "/drive/v3/files")]


def test_carpeta_cacheada_con_404_se_busca_de_nuevo(tmp_path):
    fake = FakeDrive()
    snap = tmp_path / "snap"
    _put(_storage(fake, snap, "devA"), tmp_path, "A/uno.mp3")

    # Alguien borra la carpeta y la recrea: el id guardado ya no existe.
    old_root = _id_of(fake, "Spitifo")
    new_root = fake._add("Spitifo", ["root"], "application/vnd.google-apps.folder")
    for f in fake.files.values():
        f["parents"] = [new_root if p == old_root else p for p in f["parents"]]
    del fake.files[old_root]

    proceso = _storage(fake, snap, "devA")
    fake.reset_calls()
    assert [f.key for f in proceso.list()] == ["A/uno.mp3"]
    # listado con el id viejo (404), busqueda de la carpeta, listado bueno.
    assert fake.counters["GET /drive/v3/files"] == 3
    state = json.loads((snap / "state.json").read_text("utf-8"))
    assert state["folders"][""] == new_root, "el id nuevo reemplaza al viejo"
    assert "A" not in state["folders"], "los ids de subcarpeta viejos se olvidan"


def test_crear_en_una_carpeta_cacheada_que_ya_no_existe_se_reintenta(tmp_path):
    fake = FakeDrive()
    snap = tmp_path / "snap"
    _put(_storage(fake, snap, "devA"), tmp_path, "A/uno.mp3")

    # Otro dispositivo (sin archivos propios todavia) escribe despues de que la
    # carpeta fue reemplazada: el `create` con el padre viejo da 404.
    proceso = _storage(fake, snap, "devZ")
    proceso.list()  # carga el indice con el id valido
    old_root = _id_of(fake, "Spitifo")
    new_root = fake._add("Spitifo", ["root"], "application/vnd.google-apps.folder")
    for f in fake.files.values():
        f["parents"] = [new_root if p == old_root else p for p in f["parents"]]
    del fake.files[old_root]

    _put(proceso, tmp_path, "Z/dos.mp3", b"22")
    created = fake.files[_id_of(fake, "index-devZ.json")]
    assert created["parents"] == [new_root]


def test_crear_un_archivo_chico_con_la_carpeta_vieja_se_reintenta(tmp_path):
    fake = FakeDrive()
    snap = tmp_path / "snap"
    _put(_storage(fake, snap, "devA"), tmp_path, "A/uno.mp3")

    proceso = _storage(fake, snap, "devZ")  # trae el id de Spitifo del disco
    old_root = _id_of(fake, "Spitifo")
    new_root = fake._add("Spitifo", ["root"], "application/vnd.google-apps.folder")
    for f in fake.files.values():
        f["parents"] = [new_root if p == old_root else p for p in f["parents"]]
    del fake.files[old_root]

    proceso._create_file("playlists-devZ.json", b"{}")
    created = fake.files[_id_of(fake, "playlists-devZ.json")]
    assert created["parents"] == [new_root]


def test_listado_vacio_con_carpeta_del_disco_se_verifica(tmp_path):
    """Si Drive contestara 200 vacio ante un id viejo, no se muestra vacia."""
    fake = FakeDrive()
    snap = tmp_path / "snap"
    _put(_storage(fake, snap, "devA"), tmp_path, "A/uno.mp3")

    # Fuerza el caso "200 vacio" apuntando el id cacheado a una carpeta que
    # existe pero esta vacia (no da 404).
    vacia = fake._add("Spitifo", ["root"], "application/vnd.google-apps.folder")
    state = json.loads((snap / "state.json").read_text("utf-8"))
    state["folders"][""] = vacia
    (snap / "state.json").write_text(json.dumps(state), "utf-8")

    proceso = _storage(fake, snap, "devA")
    assert [f.key for f in proceso.list()] == ["A/uno.mp3"]


# ----------------------------------------------------------------- escrituras
def test_las_escrituras_propias_refrescan_la_copia(tmp_path):
    fake = FakeDrive()
    snap = tmp_path / "snap"
    a = _storage(fake, snap, "devA")
    _put(a, tmp_path, "A/uno.mp3", b"1")
    _put(a, tmp_path, "A/dos.mp3", b"22")  # reemplaza el indice propio
    a.save_playlist(lambda book: book.upsert(_playlist("p1", "Mi lista")))

    proceso = _storage(fake, snap, "devA")
    fake.reset_calls()
    assert [f.key for f in proceso.list()] == ["A/dos.mp3", "A/uno.mp3"]
    proceso.load_playlists()
    assert _downloads(fake) == [], "lo que escribimos nosotros no se vuelve a bajar"


def test_lo_de_otros_dispositivos_se_suma_a_lo_que_escribimos(tmp_path):
    fake = FakeDrive()
    snap = tmp_path / "snap"
    a = _storage(fake, snap, "devA")
    _put(a, tmp_path, "A/uno.mp3", b"1")
    _put(_storage(fake, tmp_path / "otro", "devB"), tmp_path, "B/b.mp3", b"2")

    proceso = _storage(fake, snap, "devA")
    assert {f.key for f in proceso.list()} == {"A/uno.mp3", "B/b.mp3"}


# ----------------------------------------------------------------- seguridad
def test_un_indice_propio_ilegible_no_se_pisa_tampoco_con_copia(tmp_path):
    fake = FakeDrive()
    snap = tmp_path / "snap"
    a = _storage(fake, snap, "devA")
    _put(a, tmp_path, "A/uno.mp3", b"1")
    own_id = _id_of(fake, "index-devA.json")

    # Se rompe el remoto (con version nueva, como pasaria de verdad).
    _touch(fake, "index-devA.json", b"{roto")
    for _ in range(2):  # 1a vez baja lo roto y lo guarda; 2a sale de la copia
        otro = _storage(fake, snap, "devA")
        with pytest.raises(RuntimeError):
            _put(otro, tmp_path, "A/dos.mp3", b"2")
    assert fake.files[own_id]["data"] == b"{roto"


def test_un_indice_propio_con_error_de_red_no_se_pisa_con_copia(tmp_path):
    fake = FakeDrive()
    snap = tmp_path / "snap"
    _put(_storage(fake, snap, "devA"), tmp_path, "A/uno.mp3", b"1")
    own_id = _id_of(fake, "index-devA.json")
    antes = fake.files[own_id]["data"]
    _touch(fake, "index-devA.json", antes)  # cambio de version: hay que bajarlo

    base = fake

    def handler(request):
        if request.url.path.endswith(f"/{own_id}") and request.method == "GET":
            return httpx.Response(503)
        return base._route(request)

    fake.fail_with = handler
    otro = _storage(fake, snap, "devA", sleep=lambda _s: None)
    with pytest.raises(RuntimeError):
        _put(otro, tmp_path, "A/dos.mp3", b"2")
    assert fake.files[own_id]["data"] == antes


def test_una_copia_ilegible_se_ignora(tmp_path):
    fake = FakeDrive()
    _seed_devices(fake, tmp_path)
    snap = tmp_path / "snap"
    _storage(fake, snap, "devD").list()

    (snap / "state.json").write_text("{esto no es json", "utf-8")
    proceso = _storage(fake, snap, "devD")
    fake.reset_calls()
    assert len(proceso.list()) == 3
    assert len(_downloads(fake)) == 3  # como sin copia: baja todo
    # y la copia quedo reparada para el proximo arranque
    siguiente = _storage(fake, snap, "devD")
    fake.reset_calls()
    siguiente.list()
    assert _downloads(fake) == []


def test_un_archivo_de_la_copia_danado_se_rebaja(tmp_path):
    fake = FakeDrive()
    _seed_devices(fake, tmp_path)
    snap = tmp_path / "snap"
    _storage(fake, snap, "devD").list()

    victim = sorted((snap / "files").glob("*.bin"))[0]
    victim.write_bytes(victim.read_bytes()[:-3] + b"???")  # mismo largo, otro hash
    proceso = _storage(fake, snap, "devD")
    fake.reset_calls()
    assert len(proceso.list()) == 3
    assert len(_downloads(fake)) == 1, "solo el danado se vuelve a bajar"


def test_una_copia_de_otro_formato_se_ignora(tmp_path):
    fake = FakeDrive()
    _seed_devices(fake, tmp_path, ("devA",))
    snap = tmp_path / "snap"
    _storage(fake, snap, "devD").list()
    state = json.loads((snap / "state.json").read_text("utf-8"))
    state["v"] = 99
    (snap / "state.json").write_text(json.dumps(state), "utf-8")
    assert SmallFileSnapshot(snap).entries() == {}


def test_la_copia_no_guarda_tokens(tmp_path):
    fake = FakeDrive()
    snap = tmp_path / "snap"
    a = _storage(fake, snap, "devA")
    _put(a, tmp_path, "A/uno.mp3")
    a.save_playlist(lambda book: None)
    for path in snap.rglob("*"):
        if path.is_file():
            blob = path.read_bytes()
            assert b"token-secreto" not in blob
            assert b"Bearer" not in blob


# --------------------------------------------- fichas, descartes y escuchas
def test_fichas_descartes_y_escuchas_tambien_salen_de_la_copia(tmp_path):
    fake = FakeDrive()
    snap = tmp_path / "snap"
    a = _storage(fake, snap, "devA")
    record = {"name": "Alfa", "mbid": "m", "genres": [["rock", 3]],
              "similar": [], "fetched_at": 1_772_000_000.0, "status": "ok"}
    a.save_artistinfo({"alfa": record})
    a.dismiss_artist("X", now=1_772_000_000.0)
    a.append_listens([{"t": 1_772_000_000, "k": "A/uno.mp3", "d": 120000,
                       "l": 60000, "p": 60000, "r": "end", "o": "play"}],
                     now=1_772_000_100.0)

    # Otro dispositivo suma lo suyo (sus archivos NO estan en nuestra copia).
    b = _storage(fake, tmp_path / "snap-b", "devB")
    b.save_artistinfo({"beta": dict(record, name="Beta")})
    b.dismiss_artist("Y", now=1_772_000_001.0)

    proceso = _storage(fake, snap, "devA")
    assert set(proceso.load_artistinfo()) == {"alfa", "beta"}
    assert proceso.load_discover().dismissed_set() == {"x", "y"}
    proceso.load_listens_summary(now=1_772_000_200.0)

    de_nuevo = _storage(fake, snap, "devA")
    fake.reset_calls()
    assert set(de_nuevo.load_artistinfo()) == {"alfa", "beta"}
    assert de_nuevo.load_discover().dismissed_set() == {"x", "y"}
    de_nuevo.load_listens_summary(now=1_772_000_200.0)
    assert _downloads(fake) == []


def _playlist(playlist_id, name):
    from backend.app.playlists import Playlist
    return Playlist(id=playlist_id, name=name, keys=[], updated_at=1.0)
