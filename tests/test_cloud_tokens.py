"""Tests OFFLINE del guardado de tokens (backend/app/cloud/tokens.py)."""
from __future__ import annotations

import sys

import pytest

from backend.app.cloud import tokens as tokens_mod
from backend.app.cloud.oauth import TokenSet


def _store(tmp_path, protector=None) -> tokens_mod.TokenStore:
    return tokens_mod.TokenStore(tmp_path / "tokens",
                                 protector or tokens_mod.PlainProtector())


def test_round_trip_con_plain_protector(tmp_path):
    store = _store(tmp_path)
    tokens = TokenSet("access", "refresh", 123.0, "scope")
    store.save("google", tokens)
    assert store.load("google") == tokens


def test_load_sin_archivo_es_none(tmp_path):
    assert _store(tmp_path).load("google") is None


def test_archivo_corrupto_es_none(tmp_path):
    store = _store(tmp_path)
    store.directory.mkdir(parents=True, exist_ok=True)
    (store.directory / "google.bin").write_bytes(b"esto no es json")
    assert store.load("google") is None


def test_archivo_que_no_descifra_es_none(tmp_path):
    class ProtectorRoto(tokens_mod.PlainProtector):
        def unprotect(self, data: bytes) -> bytes:
            raise OSError("dpapi dice que no")

    store = _store(tmp_path, ProtectorRoto())
    store.save("google", TokenSet("a", None, 0.0))
    assert store.load("google") is None


def test_delete_y_no_falla_si_no_esta(tmp_path):
    store = _store(tmp_path)
    store.save("google", TokenSet("a", None, 0.0))
    store.delete("google")
    assert store.load("google") is None
    store.delete("google")


def test_nombre_de_proveedor_invalido(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(ValueError):
        store.load("../escape")


def test_default_protector_segun_el_so():
    protector = tokens_mod.default_protector()
    if sys.platform == "win32":
        assert isinstance(protector, tokens_mod.DpapiProtector)
    else:
        assert isinstance(protector, tokens_mod.PlainProtector)


def test_default_token_dir_usa_la_variable(monkeypatch, tmp_path):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    assert tokens_mod.default_token_dir() == tmp_path / "data" / "tokens"


@pytest.mark.skipif(sys.platform != "win32", reason="DPAPI es de Windows")
def test_dpapi_round_trip_y_no_deja_el_token_en_claro(tmp_path):
    store = tokens_mod.TokenStore(tmp_path / "tokens",
                                  tokens_mod.DpapiProtector())
    tokens = TokenSet("ACCESS-TOKEN-SECRETO", "refresh", 1.0, "s")
    store.save("google", tokens)
    assert store.load("google") == tokens
    en_disco = (store.directory / "google.bin").read_bytes()
    assert b"ACCESS-TOKEN-SECRETO" not in en_disco
