"""CLI para conectar un proveedor de nube desde la PC (ADR 0002, secciones 3 y 8).

El flujo de consentimiento por loopback vivia en `bench.py`; se mudo aca porque
conectar la biblioteca es una accion propia y no una medicion. `bench` reusa
`sign_in` con su propio nombre de tokens.

    python -m backend.app.cloud.connect google
    python -m backend.app.cloud.connect google --disconnect

Los tokens quedan guardados bajo el nombre del proveedor (`google`), que es el
que `drive_storage_from_env` usa despues.
"""
from __future__ import annotations

import argparse
import sys
import webbrowser
from typing import Callable, Sequence

import httpx

from .oauth import (
    InvalidGrant,
    LoopbackReceiver,
    OAuthError,
    OAuthNotConfigured,
    Provider,
    TokenSet,
    authorize_url,
    exchange_code,
    google_provider,
    microsoft_provider,
    new_pkce,
    new_state,
    refresh,
)
from .tokens import TokenStore, default_protector, default_token_dir

#: Margen del flujo de consentimiento en el loopback.
SIGN_IN_TIMEOUT = 300.0


def provider_for(which: str) -> Provider:
    """Proveedor del subcomando de la CLI."""
    if which == "google":
        return google_provider()
    if which == "onedrive":
        return microsoft_provider()
    raise ValueError(f"proveedor desconocido: {which!r}")


def sign_in(provider: Provider, store: TokenStore, name: str, *,
            browser: Callable[[str], object] = webbrowser.open,
            out: Callable[[str], object] = print) -> TokenSet | None:
    """Reusa los tokens del disco o corre el flujo del loopback y los guarda.

    Devuelve None si los tokens guardados estaban revocados: en ese caso los
    borra y pide volver a correr. Imprime si reuso el sign-in (la prueba de PC de
    que sobrevive a un reinicio). `name` es la clave bajo la que se guardan: el
    conector usa el nombre del proveedor, `bench` usa `bench-<proveedor>`.
    """
    tokens = store.load(name)
    if tokens is not None:
        out(f"Sign-in: reused from disk ({name})")
        if tokens.expired():
            with httpx.Client(timeout=30.0) as client:
                try:
                    tokens = refresh(client, provider, tokens)
                except InvalidGrant:
                    store.delete(name)
                    out("Sign-in: the stored tokens were revoked; "
                        "run the command again to sign in.")
                    return None
            store.save(name, tokens)
            out("Sign-in: access token refreshed")
        return tokens

    out(f"Sign-in: no tokens on disk, opening the browser ({name})")
    with LoopbackReceiver(provider.redirect_host) as receiver:
        redirect_uri = receiver.redirect_uri or receiver.start()
        verifier, challenge = new_pkce()
        state = new_state()
        url = authorize_url(provider, redirect_uri, state, challenge)
        out(url)
        browser(url)
        code = receiver.wait(state, timeout=SIGN_IN_TIMEOUT)
    with httpx.Client(timeout=30.0) as client:
        tokens = exchange_code(client, provider, code, verifier, redirect_uri)
    store.save(name, tokens)
    out(f"Sign-in: new tokens saved ({name})")
    return tokens


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m backend.app.cloud.connect",
        description="Conecta (o desconecta) un proveedor de nube en la PC.")
    parser.add_argument("provider", choices=("google", "onedrive"),
                        help="proveedor a conectar")
    parser.add_argument("--disconnect", action="store_true",
                        help="borra los tokens guardados y no hace sign-in")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        provider = provider_for(args.provider)
    except (OAuthNotConfigured, ValueError) as exc:
        print(f"[connect] {exc}", file=sys.stderr)
        return 2

    store = TokenStore(default_token_dir(), default_protector())
    if args.disconnect:
        store.delete(provider.name)
        print(f"Disconnected {provider.name}")
        return 0

    try:
        tokens = sign_in(provider, store, provider.name)
    except (OAuthError, OAuthNotConfigured) as exc:
        print(f"[connect] {exc}", file=sys.stderr)
        return 2
    if tokens is None:
        return 2
    print(f"Connected {provider.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
