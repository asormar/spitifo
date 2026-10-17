"""Tests OFFLINE del guardado de tokens (backend/app/cloud/tokens.py)."""
from __future__ import annotations

import sys

import pytest

import httpx

from backend.app.cloud import oauth
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


# ------------------------------------------------------------- token sources
def _provider() -> oauth.Provider:
    return oauth.Provider(name="google", authorize_url="https://a",
                          token_url="https://token", client_id="c",
                          client_secret=None, scopes=())


def _refresh_client(payload: dict | list[dict]) -> httpx.Client:
    """Cliente que responde al token endpoint con `payload` (o una lista)."""
    calls: list[int] = []
    responses = payload if isinstance(payload, list) else [payload]

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        body = responses[min(len(calls), len(responses)) - 1]
        return httpx.Response(200, json=body)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    client.calls = calls  # type: ignore[attr-defined]
    return client


def _stored(tmp_path, tokens: TokenSet | None, clock,
            payload=None) -> tokens_mod.StoredTokenSource:
    store = _store(tmp_path)
    if tokens is not None:
        store.save("google", tokens)
    return tokens_mod.StoredTokenSource(_provider(), store, "google",
                                        _refresh_client(payload or {}), clock=clock)


def test_stored_source_devuelve_el_token_vigente_sin_renovar(tmp_path):
    source = _stored(tmp_path, TokenSet("vigente", "r", 10_000.0),
                     clock=lambda: 0.0)
    assert source.access_token() == "vigente"
    assert source.client.calls == []  # no toco la red


def test_stored_source_renueva_cuando_expira_y_guarda(tmp_path):
    source = _stored(tmp_path, TokenSet("viejo", "r", 100.0),
                     clock=lambda: 1000.0,
                     payload={"access_token": "nuevo", "expires_in": 3600})
    assert source.access_token() == "nuevo"
    # El renovado quedo persistido: el proximo arranque ya lo tiene.
    assert _store(tmp_path).load("google").access_token == "nuevo"


def test_stored_source_invalidate_fuerza_la_renovacion(tmp_path):
    source = _stored(tmp_path, TokenSet("vigente", "r", 10_000.0),
                     clock=lambda: 0.0,
                     payload={"access_token": "otro", "expires_in": 3600})
    assert source.access_token() == "vigente"
    source.invalidate()  # lo que hace el adapter tras un 401
    assert source.access_token() == "otro"
    assert len(source.client.calls) == 1


def test_stored_source_sin_tokens_pide_reconectar(tmp_path):
    source = _stored(tmp_path, None, clock=lambda: 0.0)
    with pytest.raises(tokens_mod.ReconnectRequired):
        source.access_token()


def test_stored_source_con_invalid_grant_borra_y_pide_reconectar(tmp_path):
    store = _store(tmp_path)
    store.save("google", TokenSet("viejo", "r", 100.0))
    source = tokens_mod.StoredTokenSource(
        _provider(), store, "google", _refresh_client({"error": "invalid_grant"}),
        clock=lambda: 1000.0)
    with pytest.raises(tokens_mod.ReconnectRequired):
        source.access_token()
    # Revocado: los tokens se borran y el proximo intento ya no sale a la red.
    assert store.load("google") is None


def test_stored_source_sin_refresh_token_pide_reconectar(tmp_path):
    # Vencido y sin refresh token: `refresh` levanta `InvalidGrant` -> reconectar.
    source = _stored(tmp_path, TokenSet("viejo", None, 100.0),
                     clock=lambda: 1000.0)
    with pytest.raises(tokens_mod.ReconnectRequired):
        source.access_token()


def test_static_source_sin_set_pide_reconectar():
    with pytest.raises(tokens_mod.ReconnectRequired):
        tokens_mod.StaticTokenSource(clock=lambda: 0.0).access_token()


def test_static_source_devuelve_el_token_vigente():
    source = tokens_mod.StaticTokenSource(clock=lambda: 0.0)
    source.set("empujado", 100.0)
    assert source.access_token() == "empujado"


def test_static_source_vencido_pide_reconectar():
    now = [0.0]
    source = tokens_mod.StaticTokenSource(clock=lambda: now[0])
    source.set("empujado", 100.0)
    now[0] = 100.0  # justo al vencer
    with pytest.raises(tokens_mod.ReconnectRequired):
        source.access_token()


def test_static_source_invalidate_lo_descarta():
    source = tokens_mod.StaticTokenSource(clock=lambda: 0.0)
    source.set("empujado", 100.0)
    source.invalidate()
    with pytest.raises(tokens_mod.ReconnectRequired):
        source.access_token()
