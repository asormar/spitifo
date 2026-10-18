"""Tests OFFLINE de `DriveStorage.prefetch` sobre el Drive falso.

El prefetch baja el archivo ENTERO a la cache (unpinned) para que el
auto-advance lo sirva sin volver a la red. Nada sale a internet: todo pasa por
`httpx.MockTransport`.
"""
from __future__ import annotations

import os
import threading

import httpx
import pytest

from backend.app.cloud.cache import AudioCache
from backend.app.cloud.drive import DriveStorage
from fake_drive import FakeDrive

CONTENIDO = bytes(range(256)) * 4  # 1 KiB, cada offset se distingue


class TrackingTokens:
    """`TokenSource` de prueba: no toca disco ni red."""

    def __init__(self) -> None:
        self.issued = 0

    def access_token(self) -> str:
        self.issued += 1
        return f"token-{self.issued}"

    def invalidate(self) -> None:
        pass


def _storage(fake, tmp_path, *, cache=None) -> DriveStorage:
    client = httpx.Client(transport=httpx.MockTransport(fake))
    return DriveStorage(TrackingTokens(), client, "dev", cache=cache,
                        sleep=lambda _s: None)


def _cache(tmp_path) -> AudioCache:
    return AudioCache(tmp_path / "cache", budget_bytes=1 << 30)


def _put(storage, tmp_path, key, data) -> str:
    src = tmp_path / f"src-{os.urandom(4).hex()}.mp3"
    src.write_bytes(data)
    storage.put_file(key, src)
    return key


def _media_calls(fake: FakeDrive) -> int:
    """Descargas de media (`alt=media`), sin contar el indice (ya en memoria)."""
    return sum(n for key, n in fake.counters.items()
               if key.startswith("GET /drive/v3/files/"))


def _con_cache(tmp_path, fake, key):
    """Sube `key` sin cache y devuelve (storage con cache vacia, indice tibio).

    `put_file` deja el archivo PINEADO en la cache del uploader, asi que para
    probar un MISS hace falta otra instancia con la cache vacia: el indice lo
    comparten por Drive (mismo `device_id`).
    """
    subidor = _storage(fake, tmp_path)
    _put(subidor, tmp_path, key, CONTENIDO)
    storage = _storage(fake, tmp_path, cache=_cache(tmp_path))
    storage.stat(key)  # calienta el indice: el prefetch no debe releerlo
    fake.reset_calls()
    return storage


# ------------------------------------------------------------------ el puerto
def test_prefetch_baja_a_la_cache_y_luego_no_golpea_la_red(tmp_path):
    fake = FakeDrive()
    storage = _con_cache(tmp_path, fake, "A/x.mp3")

    assert storage.prefetch("A/x.mp3") is True
    assert _media_calls(fake) == 1, "una sola descarga del archivo entero"

    fake.reset_calls()
    assert b"".join(storage.open_range("A/x.mp3")) == CONTENIDO
    assert fake.calls == [], "el open_range posterior sale de la cache"


def test_prefetch_hit_no_golpea_la_red(tmp_path):
    fake = FakeDrive()
    storage = _con_cache(tmp_path, fake, "A/x.mp3")
    storage.prefetch("A/x.mp3")

    fake.reset_calls()
    assert storage.prefetch("A/x.mp3") is True
    assert fake.calls == []


def test_prefetch_queda_unpinned(tmp_path):
    """El adelanto no es sagrado: el LRU lo puede sacar si el presupuesto aprieta."""
    fake = FakeDrive()
    storage = _con_cache(tmp_path, fake, "A/x.mp3")
    storage.prefetch("A/x.mp3")

    entry = storage._entry("A/x.mp3")
    assert storage.cache._index[
        storage.cache._key(entry.remote_id, entry.revision)]["pinned"] is False


def test_prefetch_clave_desconocida_es_false(tmp_path):
    storage = _storage(FakeDrive(), tmp_path, cache=_cache(tmp_path))
    assert storage.prefetch("A/no-esta.mp3") is False


def test_prefetch_sin_cache_es_false(tmp_path):
    storage = _storage(FakeDrive(), tmp_path, cache=None)
    assert storage.prefetch("A/x.mp3") is False


def test_prefetch_borra_el_temporal_aunque_falle(tmp_path):
    fake = FakeDrive()
    storage = _con_cache(tmp_path, fake, "A/x.mp3")
    cache = storage.cache

    def caido(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sin red", request=request)

    fake.fail_with = caido
    with pytest.raises(httpx.HTTPError):
        storage.prefetch("A/x.mp3")

    sobrantes = {p.name for p in cache.root.iterdir()} - {"index.json"}
    assert sobrantes == set(), "no queda ningun temporal"


def test_prefetch_duplicado_no_baja_dos_veces(tmp_path):
    """Dos avisos seguidos con la descarga en vuelo: una sola bajada."""

    class Lento(FakeDrive):
        """Se queda en la descarga de media hasta que el test lo suelta."""

        def __init__(self) -> None:
            super().__init__()
            self.bloquear = False
            self.entro = threading.Event()
            self.soltar = threading.Event()

        def __call__(self, request: httpx.Request) -> httpx.Response:
            if (self.bloquear
                    and request.url.path.startswith("/drive/v3/files/")
                    and request.url.params.get("alt") == "media"):
                self.entro.set()
                self.soltar.wait(10)
            return super().__call__(request)

    fake = Lento()
    storage = _con_cache(tmp_path, fake, "A/x.mp3")
    fake.bloquear = True
    fake.reset_calls()

    resultado: list[bool] = []
    hilo = threading.Thread(target=lambda: resultado.append(
        storage.prefetch("A/x.mp3")))
    hilo.start()
    try:
        assert fake.entro.wait(10), "la primera descarga arranco"
        # Con la primera en vuelo, el segundo aviso NO arranca otra descarga.
        assert storage.prefetch("A/x.mp3") is False
    finally:
        fake.soltar.set()
        hilo.join(10)

    assert resultado == [True], "el prefetch que si arranco termino bien"
    assert _media_calls(fake) == 1
