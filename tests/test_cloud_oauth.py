"""Tests OFFLINE del flujo OAuth con PKCE (backend/app/cloud/oauth.py).

Nada sale a internet: los canjes usan `httpx.MockTransport` y el loopback habla
con un `httpx` real contra `127.0.0.1`, que es local.
"""
from __future__ import annotations

import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from backend.app.cloud import oauth


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.fixture(autouse=True)
def config_aislada(monkeypatch, tmp_path):
    """Ningun test lee el `oauth_clients.json` real (ni empaquetado ni del usuario).

    El empaquetado se apunta a un temporal y el directorio de datos tambien, asi
    el fallback a archivo solo ve lo que cada test escriba.
    """
    monkeypatch.setattr(oauth, "BUNDLED_CONFIG",
                        tmp_path / "bundled-oauth_clients.json")
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path))


def _write_config(tmp_path, sections: dict) -> None:
    (tmp_path / oauth.CLIENT_CONFIG_FILE).write_text(
        json.dumps(sections), encoding="utf-8")


@pytest.fixture
def google(monkeypatch) -> oauth.Provider:
    monkeypatch.setenv("SPITIFO_GOOGLE_CLIENT_ID", "gid")
    monkeypatch.setenv("SPITIFO_GOOGLE_CLIENT_SECRET", "gsecret")
    return oauth.google_provider()


# ----------------------------------------------------------------------- PKCE
def test_pkce_vector_de_la_rfc_7636_apendice_b():
    verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    assert oauth.code_challenge(verifier) == \
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


def test_new_pkce_genera_un_verifier_del_largo_esperado():
    verifier, challenge = oauth.new_pkce()
    assert len(verifier) == 64
    assert challenge == oauth.code_challenge(verifier)
    assert "=" not in challenge  # base64url sin relleno


def test_new_state_es_aleatorio():
    assert oauth.new_state() != oauth.new_state()


# ------------------------------------------------------------------ providers
def test_google_arma_urls_scopes_y_params(google):
    assert google.name == "google"
    assert google.authorize_url == oauth.GOOGLE_AUTHORIZE_URL
    assert google.token_url == oauth.GOOGLE_TOKEN_URL
    assert google.scopes == (oauth.GOOGLE_SCOPE,)
    assert google.client_secret == "gsecret"
    assert google.extra_authorize_params == {
        "access_type": "offline", "prompt": "consent"}


def test_microsoft_es_cliente_publico_sin_secret(monkeypatch):
    monkeypatch.setenv("SPITIFO_MS_CLIENT_ID", "mid")
    p = oauth.microsoft_provider()
    assert p.name == "microsoft"
    assert p.client_secret is None
    assert p.scopes == ("Files.ReadWrite.AppFolder", "offline_access")


def test_falta_de_env_nombra_la_variable(monkeypatch):
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_ID", raising=False)
    with pytest.raises(oauth.OAuthNotConfigured) as exc:
        oauth.google_provider()
    assert "SPITIFO_GOOGLE_CLIENT_ID" in str(exc.value)


# ------------------------------------------------------------ archivo de config
def test_client_config_vacio_sin_archivos():
    assert oauth.client_config() == {}


def test_config_desde_el_archivo(monkeypatch, tmp_path):
    _write_config(tmp_path, {"google": {"client_id": "file-id",
                                        "client_secret": "file-secret"}})
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_SECRET", raising=False)
    p = oauth.google_provider()
    assert p.client_id == "file-id"
    assert p.client_secret == "file-secret"


def test_env_gana_al_archivo(monkeypatch, tmp_path):
    _write_config(tmp_path, {"google": {"client_id": "file-id",
                                        "client_secret": "file-secret"}})
    monkeypatch.setenv("SPITIFO_GOOGLE_CLIENT_ID", "env-id")
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_SECRET", raising=False)
    p = oauth.google_provider()
    assert p.client_id == "env-id"
    # El campo que no esta en el entorno sale del archivo.
    assert p.client_secret == "file-secret"


def test_archivo_empaquetado_gana_al_del_usuario(tmp_path):
    bundled = tmp_path / "bundled-oauth_clients.json"
    bundled.write_text(json.dumps(
        {"google": {"client_id": "bundled", "client_secret": "s"}}),
        encoding="utf-8")
    _write_config(tmp_path, {"google": {"client_id": "usuario",
                                        "client_secret": "s"}})
    assert oauth.client_config()["google"]["client_id"] == "bundled"


def test_error_nombra_env_y_archivo(monkeypatch):
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_SECRET", raising=False)
    with pytest.raises(oauth.OAuthNotConfigured) as exc:
        oauth.google_provider()
    mensaje = str(exc.value)
    assert "SPITIFO_GOOGLE_CLIENT_ID" in mensaje
    assert oauth.CLIENT_CONFIG_FILE in mensaje


def test_microsoft_lee_solo_el_client_id(monkeypatch, tmp_path):
    _write_config(tmp_path, {"microsoft": {"client_id": "ms-file"}})
    monkeypatch.delenv("SPITIFO_MS_CLIENT_ID", raising=False)
    p = oauth.microsoft_provider()
    assert p.client_id == "ms-file"
    assert p.client_secret is None


def test_authorize_url_trae_todos_los_parametros(google):
    url = oauth.authorize_url(google, "http://127.0.0.1:1234/callback",
                              "st", "ch")
    parsed = urlparse(url)
    assert parsed.scheme == "https"
    qs = parse_qs(parsed.query)
    assert qs["response_type"] == ["code"]
    assert qs["client_id"] == ["gid"]
    assert qs["redirect_uri"] == ["http://127.0.0.1:1234/callback"]
    assert qs["scope"] == [oauth.GOOGLE_SCOPE]
    assert qs["state"] == ["st"]
    assert qs["code_challenge"] == ["ch"]
    assert qs["code_challenge_method"] == ["S256"]
    assert qs["access_type"] == ["offline"]
    assert qs["prompt"] == ["consent"]


# --------------------------------------------------------------------- tokens
def test_tokenset_expired_usa_margen():
    t = oauth.TokenSet("a", None, expires_at=1000.0)
    assert t.expired(now=950.0, margin=60) is True
    assert t.expired(now=900.0, margin=60) is False


def test_tokenset_round_trip_dict():
    t = oauth.TokenSet("a", "r", 12.5, "s")
    assert oauth.TokenSet.from_dict(t.to_dict()) == t


def test_exchange_manda_el_secret_de_google(google):
    visto = {}

    def handler(request: httpx.Request) -> httpx.Response:
        visto["body"] = request.content.decode()
        return httpx.Response(200, json={
            "access_token": "at", "refresh_token": "rt",
            "expires_in": 3600, "scope": "s"})

    with _client(handler) as client:
        tokens = oauth.exchange_code(
            client, google, "code", "verifier", "http://127.0.0.1/callback",
            now=1000.0)
    assert "client_secret=gsecret" in visto["body"]
    assert "grant_type=authorization_code" in visto["body"]
    assert "code_verifier=verifier" in visto["body"]
    assert tokens.access_token == "at"
    assert tokens.refresh_token == "rt"
    assert tokens.expires_at == 4600.0


def test_exchange_no_manda_secret_con_microsoft(monkeypatch):
    monkeypatch.setenv("SPITIFO_MS_CLIENT_ID", "mid")
    provider = oauth.microsoft_provider()
    visto = {}

    def handler(request: httpx.Request) -> httpx.Response:
        visto["body"] = request.content.decode()
        return httpx.Response(200, json={"access_token": "at", "expires_in": 60})

    with _client(handler) as client:
        oauth.exchange_code(client, provider, "c", "v", "http://localhost",
                            now=0.0)
    assert "client_secret" not in visto["body"]


def test_refresh_conserva_el_refresh_token_viejo(google):
    old = oauth.TokenSet("a", "viejo", 0.0, "s")

    def handler(request: httpx.Request) -> httpx.Response:
        # Google no devuelve refresh_token en el refresh.
        return httpx.Response(200, json={"access_token": "nuevo",
                                         "expires_in": 3600})

    with _client(handler) as client:
        tokens = oauth.refresh(client, google, old, now=10.0)
    assert tokens.access_token == "nuevo"
    assert tokens.refresh_token == "viejo"


def test_refresh_toma_el_refresh_token_nuevo_de_microsoft(monkeypatch):
    monkeypatch.setenv("SPITIFO_MS_CLIENT_ID", "mid")
    provider = oauth.microsoft_provider()
    old = oauth.TokenSet("a", "viejo", 0.0)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "access_token": "nuevo", "refresh_token": "rotado",
            "expires_in": 100})

    with _client(handler) as client:
        tokens = oauth.refresh(client, provider, old, now=0.0)
    assert tokens.refresh_token == "rotado"


def test_refresh_sin_refresh_token_pide_reconectar(google):
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no tiene que salir a la red")

    with _client(handler) as client:
        with pytest.raises(oauth.InvalidGrant):
            oauth.refresh(client, google, oauth.TokenSet("a", None, 0.0),
                          now=0.0)


def test_invalid_grant_es_su_propio_error(google):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={
            "error": "invalid_grant", "error_description": "revocado"})

    with _client(handler) as client:
        with pytest.raises(oauth.InvalidGrant):
            oauth.refresh(client, google, oauth.TokenSet("a", "r", 0.0),
                          now=0.0)


def test_otro_error_del_proveedor_es_oauth_error(google):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={
            "error": "invalid_client", "error_description": "nope"})

    with _client(handler) as client:
        with pytest.raises(oauth.OAuthError) as exc:
            oauth.exchange_code(client, google, "c", "v", "http://x", now=0.0)
    assert "invalid_client" in str(exc.value)


# ------------------------------------------------------------------- loopback
def _get(url: str) -> httpx.Response:
    with httpx.Client(timeout=5.0) as client:
        return client.get(url)


def test_loopback_entrega_el_code():
    with oauth.LoopbackReceiver() as recv:
        assert recv.redirect_uri.startswith("http://127.0.0.1:")
        resp = _get(recv.redirect_uri + "?state=st&code=AUTHCODE")
        assert resp.status_code == 200
        assert "Spitifo" in resp.text
        assert recv.wait("st", timeout=5.0) == "AUTHCODE"


def test_loopback_state_incorrecto_falla():
    with oauth.LoopbackReceiver() as recv:
        _get(recv.redirect_uri + "?state=otro&code=X")
        with pytest.raises(oauth.OAuthError):
            recv.wait("st", timeout=5.0)


def test_loopback_error_del_proveedor_falla():
    with oauth.LoopbackReceiver() as recv:
        _get(recv.redirect_uri + "?error=access_denied&state=st")
        with pytest.raises(oauth.OAuthError) as exc:
            recv.wait("st", timeout=5.0)
    assert "access_denied" in str(exc.value)


def test_loopback_ignora_el_favicon():
    with oauth.LoopbackReceiver() as recv:
        base = recv.redirect_uri.rsplit("/callback", 1)[0]
        assert _get(base + "/favicon.ico").status_code == 404
        _get(recv.redirect_uri + "?state=st&code=OK")
        assert recv.wait("st", timeout=5.0) == "OK"


def test_loopback_timeout():
    with oauth.LoopbackReceiver() as recv:
        with pytest.raises(oauth.OAuthError):
            recv.wait("st", timeout=0.2)


def test_loopback_con_localhost_para_microsoft(monkeypatch):
    # Microsoft ignora el puerto solo con `localhost` (redirect registrado
    # `http://localhost/callback`); el server sigue en 127.0.0.1.
    monkeypatch.setenv("SPITIFO_MS_CLIENT_ID", "mid")
    provider = oauth.microsoft_provider()
    with oauth.LoopbackReceiver(provider.redirect_host) as recv:
        uri = recv.redirect_uri
        assert uri.startswith("http://localhost:") and uri.endswith("/callback")
        port = urlparse(uri).port
        _get(f"http://127.0.0.1:{port}/callback?state=st&code=MS")
        assert recv.wait("st", timeout=5.0) == "MS"


def test_los_valores_se_recortan(monkeypatch):
    monkeypatch.setenv("SPITIFO_GOOGLE_CLIENT_ID", "  gid.apps.googleusercontent.com\t")
    monkeypatch.setenv("SPITIFO_GOOGLE_CLIENT_SECRET", "gsecret ")
    p = oauth.google_provider()
    assert p.client_id == "gid.apps.googleusercontent.com"
    assert p.client_secret == "gsecret"
