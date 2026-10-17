"""Tests OFFLINE de `DriveStorage` sobre el Drive falso (`tests/fake_drive.py`).

Nada sale a internet: todo pasa por `httpx.MockTransport`. Cubren el indice
compartido entre dispositivos, la cache, el path resumable y los modos de fallo
de la seccion 8 de la ADR 0002.
"""
from __future__ import annotations

import os

import httpx
import pytest

from backend.app.cloud.cache import AudioCache
from backend.app.cloud.drive import INDEX_TTL, DriveStorage, QuotaExceeded
from backend.app.cloud.oauth import Provider
from backend.app.cloud.tokens import (
    PlainProtector,
    ReconnectRequired,
    StoredTokenSource,
    TokenStore,
)
from fake_drive import FakeDrive


class TrackingTokens:
    """`TokenSource` de prueba: rota el token cuando lo invalidan."""

    def __init__(self) -> None:
        self.issued = 0
        self.invalidated = 0

    def access_token(self) -> str:
        self.issued += 1
        return f"token-{self.issued}"

    def invalidate(self) -> None:
        self.invalidated += 1


def _provider() -> Provider:
    return Provider(name="google", authorize_url="https://a",
                    token_url="https://t", client_id="c",
                    client_secret=None, scopes=())


def _storage(fake, tmp_path, device_id="devA", *, clock=None, cache=None,
             tokens=None, sleep=None) -> DriveStorage:
    client = httpx.Client(transport=httpx.MockTransport(fake))
    kwargs: dict = {}
    if clock is not None:
        kwargs["clock"] = clock
    if sleep is not None:
        kwargs["sleep"] = sleep
    return DriveStorage(tokens or TrackingTokens(), client, device_id,
                        cache=cache, **kwargs)


def _put(storage, tmp_path, key, data) -> str:
    src = tmp_path / f"src-{os.urandom(4).hex()}.mp3"
    src.write_bytes(data)
    storage.put_file(key, src)
    return key


def _cache(tmp_path, name="cache") -> AudioCache:
    return AudioCache(tmp_path / name, budget_bytes=1 << 30)


# ------------------------------------------------------------------- el indice
def test_stat_no_golpea_la_red_con_el_indice_fresco(tmp_path):
    fake = FakeDrive()
    storage = _storage(fake, tmp_path)
    key = _put(storage, tmp_path, "A/x.mp3", b"0123456789")

    fake.reset_calls()
    f = storage.stat(key)
    assert f.size == 10
    assert fake.calls == []


def test_el_indice_se_relee_despues_del_ttl(tmp_path):
    fake = FakeDrive()
    now = [1000.0]
    storage = _storage(fake, tmp_path, clock=lambda: now[0])
    key = _put(storage, tmp_path, "A/x.mp3", b"0123456789")

    fake.reset_calls()
    storage.stat(key)
    assert fake.calls == []

    now[0] += INDEX_TTL + 1
    storage.stat(key)
    assert fake.calls == [], "stat de una clave conocida nunca espera a la red"

    storage.list()
    assert fake.calls, "pasado el TTL, list() relee index-*.json"


def test_dos_dispositivos_merge_tombstone_y_republicacion(tmp_path):
    fake = FakeDrive()
    now = [1000.0]
    a = _storage(fake, tmp_path, "A", clock=lambda: now[0])
    b = _storage(fake, tmp_path, "B", clock=lambda: now[0])
    key = _put(a, tmp_path, "A/A - tema.mp3", b"original")

    now[0] += INDEX_TTL + 1
    assert [f.key for f in b.list()] == [key]  # B ve lo de A tras recargar

    b.delete(key)
    now[0] += INDEX_TTL + 1
    assert a.list() == []  # el tombstone de B gana
    with pytest.raises(FileNotFoundError):
        a.stat(key)

    now[0] += INDEX_TTL + 1
    _put(a, tmp_path, key, b"nuevo!")
    now[0] += INDEX_TTL + 1
    assert [f.key for f in b.list()] == [key]  # A lo volvio a publicar
    assert b.stat(key).size == 6


def test_put_sobre_la_misma_clave_actualiza_en_sitio(tmp_path):
    fake = FakeDrive()
    storage = _storage(fake, tmp_path, cache=None)
    src1 = tmp_path / "a.mp3"
    src1.write_bytes(b"aaaa")
    first = storage.put_file("A/x.mp3", src1)
    src2 = tmp_path / "b.mp3"
    src2.write_bytes(b"bb")
    second = storage.put_file("A/x.mp3", src2)

    assert second.etag != first.etag
    assert storage.stat("A/x.mp3").size == 2
    copias = [f for f in fake.files.values() if f["name"] == "x.mp3"]
    assert len(copias) == 1


def test_archivo_grande_usa_resumable_y_los_bytes_coinciden(tmp_path):
    fake = FakeDrive()
    storage = _storage(fake, tmp_path, cache=None)
    data = os.urandom(9 * 1024 * 1024 + 7)
    key = _put(storage, tmp_path, "A/grande.m4a", data)

    assert fake.resumable_sessions >= 1
    assert fake.resumable_puts >= 2  # mas de un chunk de 8 MiB: hubo un 308

    reader = _storage(fake, tmp_path, "reader", cache=None)
    assert b"".join(reader.open_range(key)) == data


# --------------------------------------------------------------------- cache
def test_open_range_desde_la_cache_no_golpea_la_red(tmp_path):
    fake = FakeDrive()
    cache = _cache(tmp_path)
    storage = _storage(fake, tmp_path, cache=cache)
    data = bytes(range(256)) * 8
    key = _put(storage, tmp_path, "A/x.mp3", data)

    fake.reset_calls()
    assert b"".join(storage.open_range(key)) == data
    assert b"".join(storage.open_range(key, 10, 20)) == data[10:21]
    assert fake.calls == []


# --------------------------------------------------------------------- fallos
def test_401_invalida_el_token_y_reintenta_una_vez(tmp_path):
    fake = FakeDrive()
    fake.fail_401 = 1
    tokens = TrackingTokens()
    storage = _storage(fake, tmp_path, tokens=tokens)

    assert list(storage.list()) == []
    assert tokens.invalidated == 1
    # Los dos primeros GET son el original (401) y el reintento.
    assert fake.calls[:2] == [("GET", "/drive/v3/files"),
                              ("GET", "/drive/v3/files")]


def test_429_respeta_retry_after_y_reintenta(tmp_path):
    fake = FakeDrive()
    fake.fail_429 = 1
    fake.retry_after = "2"
    slept: list[float] = []
    storage = _storage(fake, tmp_path, sleep=slept.append)

    list(storage.list())
    assert slept == [2.0]


def test_cuota_llena_levanta_quota_exceeded(tmp_path):
    fake = FakeDrive()
    fake.quota = True
    storage = _storage(fake, tmp_path)

    with pytest.raises(QuotaExceeded):
        list(storage.list())


def test_sin_tokens_guardados_pide_reconectar(tmp_path):
    fake = FakeDrive()
    store = TokenStore(tmp_path / "tokens", PlainProtector())
    client = httpx.Client(transport=httpx.MockTransport(fake))
    source = StoredTokenSource(_provider(), store, "google", client)
    storage = DriveStorage(source, client, "devA", sleep=lambda _s: None)

    with pytest.raises(ReconnectRequired):
        list(storage.list())


# ------------------------------------------------------------------ varios
def test_describe_nombra_drive(tmp_path):
    storage = _storage(FakeDrive(), tmp_path)
    assert storage.describe() == "Google Drive: Spitifo"


def test_default_device_id_es_estable(tmp_path):
    from backend.app.cloud.drive import default_device_id

    data_dir = tmp_path / "data"
    first = default_device_id(data_dir)
    assert first == default_device_id(data_dir)
    assert (data_dir / "device_id").read_text("utf-8").strip() == first


def test_un_indice_propio_ilegible_no_se_pisa(tmp_path):
    fake = FakeDrive()
    now = [1000.0]
    a = _storage(fake, tmp_path, "A", clock=lambda: now[0])
    _put(a, tmp_path, "A/uno.mp3", b"1")
    own = next(f for f in fake.files.values() if f["name"] == "index-A.json")
    antes = own["data"]
    own["data"] = b"{roto"  # p.ej. un corte a mitad de la descarga

    otro = _storage(fake, tmp_path, "A", clock=lambda: now[0])
    with pytest.raises(RuntimeError):
        _put(otro, tmp_path, "A/dos.mp3", b"2")
    assert own["data"] == b"{roto", "no puede reemplazarlo por un indice casi vacio"
    own["data"] = antes


def test_reemplazar_despinea_la_revision_vieja(tmp_path):
    fake = FakeDrive()
    cache = _cache(tmp_path)
    storage = _storage(fake, tmp_path, cache=cache)
    key = _put(storage, tmp_path, "A/x.mp3", b"v1")
    vieja = storage.stat(key).etag
    _put(storage, tmp_path, key, b"v2-mas-largo")
    remote_id = storage._entry(key).remote_id
    assert cache._index[cache._key(remote_id, vieja)]["pinned"] is False


def test_quota_suma_lo_de_spitifo_y_se_cachea(tmp_path):
    fake = FakeDrive()
    fake.extra_usage = 1000
    now = [1000.0]
    storage = _storage(fake, tmp_path, clock=lambda: now[0])
    _put(storage, tmp_path, "A/x.mp3", b"0123456789")
    _put(storage, tmp_path, "A/notas.txt", b"no es audio")

    q = storage.quota()
    assert q["limit"] == 15 * 1024 ** 3
    assert q["app"] == 10  # solo audio vivo del indice
    assert q["usage"] >= 1010

    fake.reset_calls()
    storage.quota()
    assert fake.calls == [], "dentro del TTL no vuelve a preguntar"
