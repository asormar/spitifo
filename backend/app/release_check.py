"""Chequeo de la ultima release de Spitifo en GitHub, para el aviso de
actualizacion de Ajustes (R2-install-e).

Mismo truco que ytdlp_update.py para no tocar la API de GitHub (sin token son
60 pedidos por hora por IP): se pide `.../releases/latest` SIN seguir el
redirect y el tag sale del `Location` (`/releases/tag/<tag>`). El resultado se
cachea en memoria 24 h; el boton "Buscar actualizaciones" del frontend fuerza
un chequeo nuevo con `force=True`. Nunca lanza: sin internet es un estado
tranquilo (version/url en None), no un error.
"""
from __future__ import annotations

import logging
import re
import time

import httpx

log = logging.getLogger("spitifo.release_check")

REPO = "asormar/spitifo"
LATEST_URL = f"https://github.com/{REPO}/releases/latest"
RELEASE_URL = f"https://github.com/{REPO}/releases/tag/"
_TAG_EN_LOCATION = "/releases/tag/"
#: Los tags del proyecto son "vX.Y.Z" (release.yml: tags ["v*"]).
_TAG_VALIDA = re.compile(r"^v\d+\.\d+\.\d+$")
#: No tiene sentido consultar GitHub mas de una vez al dia.
CHECK_INTERVAL = 24 * 60 * 60
#: Un fallo (sin red) se recuerda poco: al volver la red se vuelve a mirar.
FAIL_INTERVAL = 60 * 60
TIMEOUT = httpx.Timeout(5.0)

#: {"checked_at": float, "version": str | None, "url": str | None}
_cache: dict | None = None


def reset_cache() -> None:
    """Limpia la cache en memoria (la usan los tests, para no filtrar entre si)."""
    global _cache
    _cache = None


def latest_release(client: httpx.Client | None = None, *, force: bool = False) -> dict:
    """Ultima version publicada, cacheada 24 h: {"version", "url"}.

    `version` sale sin la "v" inicial del tag; `url` apunta a esa release en
    GitHub. Los dos quedan en None cuando no se pudo averiguar (sin internet,
    GitHub no redirigio, tag con forma rara): un estado tranquilo, no un error.
    `force=True` ignora la cache (lo usa el boton manual).
    """
    global _cache
    ahora = time.time()
    vigencia = CHECK_INTERVAL if _cache and _cache["version"] else FAIL_INTERVAL
    if not force and _cache is not None and ahora - _cache["checked_at"] < vigencia:
        return {"version": _cache["version"], "url": _cache["url"]}

    propio = client is None
    if propio:
        # Sin seguir redirects: el tag de la ultima release sale justamente
        # del 302 de /releases/latest.
        client = httpx.Client(timeout=TIMEOUT, follow_redirects=False)
    try:
        tag = _latest_tag(client)
    except Exception as exc:
        log.info("release: no se pudo consultar GitHub: %s", exc)
        tag = None
    finally:
        if propio:
            client.close()

    version = tag[1:] if tag else None
    url = f"{RELEASE_URL}{tag}" if tag else None
    _cache = {"checked_at": ahora, "version": version, "url": url}
    return {"version": version, "url": url}


def _latest_tag(client: httpx.Client) -> str | None:
    resp = client.get(LATEST_URL, follow_redirects=False)
    if not resp.is_redirect:
        log.warning("release: %s no redirigio (status %s)",
                    LATEST_URL, resp.status_code)
        return None
    return _tag_del_location(resp.headers.get("location"))


def _tag_del_location(location: str | None) -> str | None:
    """Tag extraido de un `Location` tipo `.../releases/tag/<tag>`."""
    if not location or _TAG_EN_LOCATION not in location:
        return None
    resto = location.rsplit(_TAG_EN_LOCATION, 1)[1]
    tag = resto.split("?", 1)[0].strip("/")
    return tag if _TAG_VALIDA.match(tag) else None
