"""Tests de las correcciones de escala de la biblioteca en Drive (round4-perf).

Todo OFFLINE: Drive falso (`fake_drive.FakeDrive`) y almacenamiento local
temporal, como el resto de la suite. Cubre:

- Negative lookups: `_entry`/`stat` con `allow_force=False` y la cache de
  claves ausentes (P-drive-io-1, P-drive-io-8).
- Write coalescing: `batch_index_writes` sube el indice una sola vez por
  tanda, no una por archivo (P-drive-io-2, P-large-library-scale-3).
- Crash-safety: lo que ya se subio a la nube sobrevive aunque el indice de
  la tanda no llegue a subirse.
- Concurrencia de dos escritores: varias descargas a la vez (misma tanda, o
  dos dispositivos) no se pisan ni se pierden.
- La cache de audio no reescribe su `index.json` en cada acierto.
- El refresh de token no bloquea el camino caliente.
- El 304 de `/api/library`.
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from backend.app.cloud.cache import AudioCache
from backend.app.cloud.drive import INDEX_TTL, DriveStorage
from backend.app.cloud.library_index import LibraryIndex
from backend.app.cloud.oauth import Provider, TokenSet
from backend.app.cloud.tokens import PROACTIVE_REFRESH_MARGIN, StoredTokenSource
from backend.app.main import create_app
from backend.app.storage import set_storage
from backend.app.storage.local import LocalStorage
from fake_drive import FakeDrive


class _FakeTokens:
    def access_token(self) -> str:
        return "test-token"

    def invalidate(self) -> None:
        pass


def _storage(fake, tmp_path, device_id="A", *, clock=None) -> DriveStorage:
    client = httpx.Client(transport=httpx.MockTransport(fake))
    kwargs = {}
    if clock is not None:
        kwargs["clock"] = clock
    cache = AudioCache(tmp_path / f"cache-{device_id}", budget_bytes=1 << 30)
    return DriveStorage(_FakeTokens(), client, device_id, cache=cache, **kwargs)


def _origen(tmp_path: Path, data: bytes) -> Path:
    src = tmp_path / f"origen-{os.urandom(4).hex()}.mp3"
    src.write_bytes(data)
    return src


def _put(storage, tmp_path, key, data=b"0123456789") -> None:
    storage.put_file(key, _origen(tmp_path, data))


def _index_list_calls(fake: FakeDrive) -> list:
    """Los `files.list` que piden `index-*` (no folder lookups: esos tambien
    pegan a `/drive/v3/files` pero buscan por `mimeType`/`parents`, nunca por
    `name contains 'index-'`)."""
    return [q for q in fake.list_queries if "index-" in q]


# --------------------------------------------------------- negative lookups
def test_put_files_no_relista_por_tres_claves_nuevas(tmp_path):
    """P-drive-io-1: audio + 2 portadas de una descarga nueva no fuerzan tres
    relecturas completas del indice (ni siquiera una, con el indice ya tibio)."""
    fake = FakeDrive()
    storage = _storage(fake, tmp_path)
    _put(storage, tmp_path, "A/existente.mp3")  # tibia el indice
    fake.reset_calls()

    lote = [("B/b.m4a", _origen(tmp_path, b"a")),
            ("B/b.jpg", _origen(tmp_path, b"b")),
            ("B/b.s.jpg", _origen(tmp_path, b"c"))]
    storage.put_files(lote)

    assert _index_list_calls(fake) == [], (
        "tres claves nuevas en una descarga no deberian listar el indice")


def test_stat_con_allow_force_false_no_pega_a_la_red(tmp_path):
    """El chequeo de 'ya existe' antes de subir una imagen content-addressed
    (P-drive-io-8) no fuerza el indice cuando la clave es nueva."""
    fake = FakeDrive()
    storage = _storage(fake, tmp_path)
    _put(storage, tmp_path, "A/existente.mp3")
    fake.reset_calls()

    with pytest.raises(FileNotFoundError):
        storage.stat(".art/deadbeef.jpg", allow_force=False)
    assert _index_list_calls(fake) == []

    # El default sigue forzando: una clave de verdad ausente SI gasta un listado.
    with pytest.raises(FileNotFoundError):
        storage.stat(".art/deadbeef.jpg")
    assert _index_list_calls(fake) != []


def test_una_clave_ausente_confirmada_no_se_reconsulta_dentro_del_ttl(tmp_path):
    """La cache de claves ausentes (`MISSING_TTL`) evita repetir el listado
    forzado por la MISMA clave mientras siga fresca."""
    fake = FakeDrive()
    now = [1000.0]
    storage = _storage(fake, tmp_path, clock=lambda: now[0])
    _put(storage, tmp_path, "A/existente.mp3")
    fake.reset_calls()

    with pytest.raises(FileNotFoundError):
        storage.stat("A/fantasma.mp3")
    primeros = len(_index_list_calls(fake))
    assert primeros >= 1

    fake.reset_calls()
    with pytest.raises(FileNotFoundError):
        storage.stat("A/fantasma.mp3")
    assert _index_list_calls(fake) == [], (
        "la misma clave ausente no deberia volver a forzar un listado")


# -------------------------------------------------------------- write coalescing
def test_batch_index_writes_sube_el_indice_una_sola_vez(tmp_path):
    """P-drive-io-2 / P-large-library-scale-3: tres descargas dentro de un
    `batch_index_writes` comparten UNA sola subida del indice."""
    fake = FakeDrive()
    storage = _storage(fake, tmp_path)

    with storage.batch_index_writes():
        for i in range(3):
            _put(storage, tmp_path, f"A/t{i}.mp3", b"x" * (i + 1))
        # El cambio se ve en memoria YA, aunque nada se haya subido todavia.
        assert {f.key for f in storage.list()} == {f"A/t{i}.mp3" for i in range(3)}
        indices_a_medias = [f for f in fake.files.values()
                            if f["name"].startswith("index-")]
        assert indices_a_medias == [], "el indice no sube hasta cerrar el bloque"

    indices = [f for f in fake.files.values() if f["name"].startswith("index-")]
    assert len(indices) == 1
    assert indices[0]["version"] == 1, "una sola escritura, no tres"


def test_fuera_de_un_batch_la_escritura_sigue_siendo_sincronica(tmp_path):
    """Sin `batch_index_writes`, el comportamiento de siempre no cambia:
    `put_file` no vuelve hasta que el indice esta en la nube."""
    fake = FakeDrive()
    storage = _storage(fake, tmp_path)

    _put(storage, tmp_path, "A/x.mp3")

    indices = [f for f in fake.files.values() if f["name"].startswith("index-")]
    assert len(indices) == 1, "sin tanda, la subida es inmediata como siempre"


# ------------------------------------------------------------- crash-safety
def test_un_corte_a_mitad_de_la_tanda_no_pierde_lo_ya_subido(tmp_path):
    """Si el proceso se corta DENTRO de un `batch_index_writes` (nadie llama a
    `flush_index`), los archivos ya subidos siguen en la nube: lo unico que
    falta es el registro, y `flush_index` (el cierre de la app) lo recupera."""
    fake = FakeDrive()
    storage = _storage(fake, tmp_path)

    cm = storage.batch_index_writes()
    cm.__enter__()  # entra al bloque y nunca sale: simula el corte
    _put(storage, tmp_path, "A/t0.mp3", b"x")

    assert {f["name"] for f in fake.files.values()} >= {"t0.mp3"}, (
        "el audio ya esta en la nube aunque el indice no se haya subido")
    assert not any(f["name"].startswith("index-") for f in fake.files.values())

    # El cierre de la app (o la red de seguridad de `flush_all`) termina lo
    # que quedo pendiente: nada se pierde de verdad, solo se demoro.
    storage.flush_index()
    assert [f.key for f in storage.list()] == ["A/t0.mp3"]
    assert sum(1 for f in fake.files.values()
              if f["name"].startswith("index-")) == 1


# --------------------------------------------------------- dos escritores
def test_descargas_concurrentes_dentro_de_un_batch_no_se_pierden(tmp_path):
    """Cinco `put_file` a la vez (dos descargas que terminan juntas, en una
    escala mayor) no se pisan: las cinco quedan indexadas con UNA subida."""
    fake = FakeDrive()
    storage = _storage(fake, tmp_path)

    with storage.batch_index_writes():
        def subir(i: int) -> None:
            _put(storage, tmp_path, f"A/t{i}.mp3", b"x" * (i + 1))

        hilos = [threading.Thread(target=subir, args=(i,)) for i in range(5)]
        for h in hilos:
            h.start()
        for h in hilos:
            h.join()

    claves = {f.key for f in storage.list()}
    assert claves == {f"A/t{i}.mp3" for i in range(5)}
    indices = [f for f in fake.files.values() if f["name"].startswith("index-")]
    assert len(indices) == 1


def test_dos_dispositivos_escribiendo_a_la_vez_mergean_sin_perder_nada(tmp_path):
    """Dos `DriveStorage` (dos dispositivos) sobre el MISMO Drive falso,
    subiendo a la vez: el merge por `index-<device>.json` no pierde ninguno."""
    fake = FakeDrive()
    now = [1000.0]
    a = _storage(fake, tmp_path, "A", clock=lambda: now[0])
    b = _storage(fake, tmp_path, "B", clock=lambda: now[0])

    ta = threading.Thread(target=_put, args=(a, tmp_path, "A/a.mp3"))
    tb = threading.Thread(target=_put, args=(b, tmp_path, "B/b.mp3"))
    ta.start()
    tb.start()
    ta.join()
    tb.join()

    now[0] += INDEX_TTL + 1
    assert {f.key for f in a.list()} == {"A/a.mp3", "B/b.mp3"}


def _own_index_files(fake: FakeDrive, device_id: str = "A") -> list[str]:
    return [fid for fid, f in fake.files.items()
            if f["name"] == f"index-{device_id}.json"]


def test_dos_subidas_del_indice_a_la_vez_no_se_pisan(tmp_path):
    """Dos descargas que terminan juntas, FUERA de una tanda: la subida del
    indice de la primera tarda, la segunda aplica su cambio mientras tanto.
    Tiene que quedar UN solo `index-A.json` y con las dos claves (sin el
    candado de subida, la segunda creaba un segundo archivo, o la vieja
    pisaba a la nueva)."""
    fake = FakeDrive()
    storage = _storage(fake, tmp_path)
    original = storage._store_small
    primera = threading.Event()

    def lenta(name, data, ref=None):
        if name.startswith("index-") and not primera.is_set():
            primera.set()
            limite = time.monotonic() + 2
            while ("A/b.mp3" not in storage._own.entries
                   and time.monotonic() < limite):
                time.sleep(0.01)
        return original(name, data, ref)

    storage._store_small = lenta
    ta = threading.Thread(target=_put, args=(storage, tmp_path, "A/a.mp3"))
    ta.start()
    assert primera.wait(2)
    tb = threading.Thread(target=_put, args=(storage, tmp_path, "A/b.mp3"))
    tb.start()
    ta.join()
    tb.join()

    propios = _own_index_files(fake)
    assert len(propios) == 1
    subido = LibraryIndex.from_bytes(fake.data_of(propios[0]))
    assert {"A/a.mp3", "A/b.mp3"} <= set(subido.entries)


def test_un_archivo_chico_nuevo_invalida_el_listado_combinado(tmp_path):
    """El listado combinado del arranque no conoce el indice que se crea
    despues: una relectura forzada dentro de su TTL tiene que verlo igual
    (si no, el indice propio quedaba "ausente" y la proxima escritura
    creaba un segundo `index-A.json`)."""
    fake = FakeDrive()
    now = [1000.0]
    storage = _storage(fake, tmp_path, clock=lambda: now[0])
    storage.warm_small_files()
    _put(storage, tmp_path, "A/x.mp3")

    assert "A/x.mp3" in storage._load_index(force=True).entries
    _put(storage, tmp_path, "A/y.mp3")
    assert len(_own_index_files(fake)) == 1


def test_un_cambio_sin_subir_sobrevive_a_la_relectura_por_ttl(tmp_path):
    """La subida del indice falla (sin red): el cambio queda en memoria y
    marcado. Una relectura por TTL no lo pisa con la copia vieja de la nube,
    y el proximo `flush_index` lo sube."""
    fake = FakeDrive()
    now = [1000.0]
    storage = _storage(fake, tmp_path, clock=lambda: now[0])
    _put(storage, tmp_path, "A/1.mp3")

    original = storage._store_small

    def sin_red(name, data, ref=None):
        if name.startswith("index-"):
            raise httpx.ConnectError("sin red")
        return original(name, data, ref)

    storage._store_small = sin_red
    with pytest.raises(httpx.ConnectError):
        _put(storage, tmp_path, "A/2.mp3")
    storage._store_small = original

    now[0] += INDEX_TTL + 1
    assert "A/2.mp3" in storage._load_index().entries
    storage.flush_index()

    (tmp_path / "otra").mkdir()
    otra = _storage(fake, tmp_path / "otra", clock=lambda: now[0])
    assert {"A/1.mp3", "A/2.mp3"} <= {f.key for f in otra.list()}


# ------------------------------------------------------------- audio cache
def test_cache_get_no_reescribe_index_json_en_cada_acierto(tmp_path):
    """P-drive-io-10: un acierto de cache (`get`) actualiza el orden LRU en
    memoria pero no reescribe `index.json` en cada byte-range."""
    cache = AudioCache(tmp_path / "cache", budget_bytes=1 << 30)
    src = tmp_path / "a.mp3"
    src.write_bytes(b"hola")
    cache.put("r1", "v1", src, ".mp3")

    index_path = tmp_path / "cache" / "index.json"
    antes = index_path.read_bytes()
    antes_mtime = index_path.stat().st_mtime_ns

    for _ in range(5):
        assert cache.get("r1", "v1") is not None

    assert index_path.read_bytes() == antes
    # El archivo ni se tocó (ni siquiera un replace que conserve el contenido).
    assert index_path.stat().st_mtime_ns == antes_mtime


# ------------------------------------------------------------ token refresh
def _provider() -> Provider:
    return Provider(name="google", authorize_url="https://a", token_url="https://t",
                    client_id="c", client_secret=None, scopes=())


class _MemoryTokenStore:
    def __init__(self, tokens: TokenSet) -> None:
        self._tokens = tokens
        self.saves = 0

    def load(self, name: str) -> TokenSet:
        return self._tokens

    def save(self, name: str, tokens: TokenSet) -> None:
        self.saves += 1
        self._tokens = tokens

    def delete(self, name: str) -> None:
        self._tokens = None


def test_el_refresh_proactivo_no_bloquea_el_camino_caliente(tmp_path):
    """P-drive-io-9: con margen (ni vencido ni cerca de los 60s de siempre),
    `access_token` devuelve YA el token vigente y dispara el refresh de
    fondo, sin que el llamador espere la vuelta de red."""
    now = [1000.0]
    vigente = TokenSet(access_token="viejo", refresh_token="r",
                       expires_at=now[0] + PROACTIVE_REFRESH_MARGIN - 1)
    store = _MemoryTokenStore(vigente)

    llamada_lenta = threading.Event()

    def client_lento(method, url, **kw):
        llamada_lenta.wait(2.0)
        return httpx.Response(200, json={
            "access_token": "nuevo", "refresh_token": "r",
            "expires_in": 3600, "token_type": "Bearer"})

    client = httpx.Client(transport=httpx.MockTransport(
        lambda req: client_lento(req.method, str(req.url))))
    source = StoredTokenSource(_provider(), store, "google", client,
                               clock=lambda: now[0])

    t0 = time.monotonic()
    token = source.access_token()
    elapsed = time.monotonic() - t0

    assert token == "viejo", "el token vigente se devuelve sin esperar el refresh"
    assert elapsed < 1.0, "el refresh de fondo no puede bloquear el llamador"
    llamada_lenta.set()


# --------------------------------------------------------------- /api/library
@pytest.fixture
def api(tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    storage = LocalStorage(root, device_id="d1")
    set_storage(storage)
    try:
        with TestClient(create_app()) as client:
            yield client, root
    finally:
        set_storage(None)


def test_library_devuelve_etag_y_304_si_no_cambio(api):
    """P-large-library-scale-8 / P-network-caching-6."""
    client, root = api
    (root / "A").mkdir()
    (root / "A" / "A - x.mp3").write_bytes(b"0123456789")

    primero = client.get("/api/library")
    assert primero.status_code == 200
    etag = primero.headers.get("etag")
    assert etag

    segundo = client.get("/api/library", headers={"If-None-Match": etag})
    assert segundo.status_code == 304
    assert segundo.content == b""


def test_library_etag_cambia_si_la_biblioteca_cambia(api):
    client, root = api
    (root / "A").mkdir()
    (root / "A" / "A - x.mp3").write_bytes(b"0123456789")
    etag1 = client.get("/api/library").headers.get("etag")

    (root / "A" / "A - y.mp3").write_bytes(b"otra")
    r2 = client.get("/api/library", headers={"If-None-Match": etag1})
    assert r2.status_code == 200
    assert r2.headers.get("etag") != etag1
