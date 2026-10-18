"""Actualizacion automatica de yt-dlp, en segundo plano y sin `pip`.

YouTube rompe yt-dlp varias veces al año y en Android no hay `pip`. En vez de
depender del usuario, al arrancar el backend se consulta la ultima release de
yt-dlp y, si es mas nueva que la que esta cargada, se baja el zipapp oficial, se
verifica su SHA-256 contra `SHA2-256SUMS` y se deja listo para el PROXIMO
arranque (reemplazar el modulo ya importado no tiene efecto). `runtime.py` es
quien lo carga al arrancar: lee `current.json` y mete la ruta del zip en
`sys.path`.

Nada de API de GitHub: sin token son 60 pedidos por hora por IP y ya nos comio
un 403. El tag de la ultima release sale del redirect de `.../releases/latest`
(GitHub contesta 302 y el tag esta al final del `Location`, en
`/releases/tag/<tag>`) y las URLs de los assets se arman a mano. La consulta del
tag NO sigue el redirect; las descargas SI (terminan en
objects.githubusercontent.com).

El estado vive junto a los zip, en el directorio que devuelve
`runtime.ytdlp_update_dir()`:

    current.json                 {"version", "file", "sha256", "checked_at"}
    yt-dlp-<version>.zip         el zipapp verificado (con shebang)

Se conservan solo el zip actual y el anterior: si el nuevo quedara roto, el
arranque puede volver al anterior a mano.

Nada de red en los tests: todo HTTP pasa por un `httpx.Client` inyectable.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
import threading
import time
import zipfile
from pathlib import Path

import httpx

from . import runtime

log = logging.getLogger("spitifo.ytdlp_update")

#: Pagina "latest" de GitHub: contesta 302 y el tag va en el `Location`.
LATEST_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest"
#: Base de descarga directa; despues van el tag y el nombre del asset.
DOWNLOAD_URL = "https://github.com/yt-dlp/yt-dlp/releases/download"
#: El zipapp oficial: un zip con shebang, importable por zipimport.
ASSET_ZIPAPP = "yt-dlp"
#: Sumas de la propia release, linea "<hex>  <archivo>".
ASSET_SUMS = "SHA2-256SUMS"
#: Marca que separa el tag dentro del `Location` de `/releases/latest`.
_TAG_EN_LOCATION = "/releases/tag/"
#: Un tag de yt-dlp es solo digitos y puntos (por ejemplo 2026.10.18).
_TAG_VALIDA = re.compile(r"^[0-9]+(?:\.[0-9]+)*$")
#: No tiene sentido consultar GitHub en cada arranque.
CHECK_INTERVAL = 24 * 60 * 60
TIMEOUT = httpx.Timeout(15.0)
_MANIFEST = "current.json"


def check_and_update(client: httpx.Client | None = None) -> str | None:
    """Baja e instala una yt-dlp mas nueva, si la hay.

    Devuelve la version instalada (la que se usara en el proximo arranque) o
    None si no habia nada nuevo, si toca esperar, o si algo fallo. Nunca lanza:
    es un chequeo de fondo y no puede tumbar el backend.
    """
    try:
        return _check_and_update(client)
    except Exception as exc:
        log.warning("yt-dlp: la verificacion de actualizacion fallo: %s", exc)
        return None


def pending_version() -> str | None:
    """Version bajada que todavia no es la cargada, o None.

    Es lo que expone /api/health: si hay un zip nuevo esperando el reinicio, el
    frontend lo puede mostrar.
    """
    try:
        manifest = runtime.read_ytdlp_manifest()
    except Exception:
        return None
    pendiente = _version_instalada(manifest)
    if pendiente and pendiente != runtime.ytdlp_version():
        return pendiente
    return None


def start_background_check(delay: float = 10.0) -> threading.Thread:
    """Lanza el chequeo en un thread daemon, despues de `delay` segundos.

    El delay deja que el backend termine de arrancar (y que el primer
    `import yt_dlp`, que es lento, ocurra) antes de tocar la red.
    """
    def _correr() -> None:
        time.sleep(delay)
        check_and_update()

    hilo = threading.Thread(target=_correr, name="ytdlp-autoupdate", daemon=True)
    hilo.start()
    return hilo


# --------------------------------------------------------------- implementacion
def _check_and_update(client: httpx.Client | None) -> str | None:
    if _deshabilitado():
        log.debug("yt-dlp: autoupdate deshabilitado por SPITIFO_YTDLP_AUTOUPDATE")
        return None
    if _carpeta_del_usuario():
        log.info("SPITIFO_YTDLP_DIR no tiene current.json: es carpeta del "
                 "usuario, no se actualiza")
        return None

    directorio = runtime.ytdlp_update_dir()
    manifest = runtime.read_ytdlp_manifest(directorio)
    ahora = time.time()
    if _al_dia(manifest, ahora):
        return None

    propio = client is None
    if propio:
        # Sin seguir redirects: el tag de la ultima release sale justamente del
        # 302. Las descargas piden `follow_redirects=True` por request.
        client = httpx.Client(timeout=TIMEOUT, follow_redirects=False)
    try:
        return _consultar(client, directorio, manifest, ahora)
    finally:
        if propio:
            client.close()


def _deshabilitado() -> bool:
    valor = os.getenv("SPITIFO_YTDLP_AUTOUPDATE", "").strip().lower()
    return valor in ("0", "false", "no")


def _carpeta_del_usuario() -> bool:
    """Con `SPITIFO_YTDLP_DIR` seteado y sin manifest, la carpeta la maneja el usuario."""
    if not os.getenv("SPITIFO_YTDLP_DIR", ""):
        return False
    return runtime.read_ytdlp_manifest() is None


def _al_dia(manifest: dict | None, ahora: float) -> bool:
    """True si ya se chequeo hace menos de CHECK_INTERVAL."""
    if not manifest:
        return False
    try:
        return (ahora - float(manifest.get("checked_at") or 0)) < CHECK_INTERVAL
    except (TypeError, ValueError):
        return False


def _version_instalada(manifest: dict | None) -> str | None:
    """Version que declara el manifest, como string, o None."""
    if not manifest:
        return None
    version = manifest.get("version")
    return str(version) if version else None


def latest_tag(client: httpx.Client | None = None) -> str | None:
    """Ultimo tag de yt-dlp, sin tocar la API de GitHub.

    Pide `.../releases/latest` SIN seguir el redirect: GitHub contesta 302 y el
    tag esta al final del `Location` (`/releases/tag/<tag>`). Devuelve el tag
    normalizado (sin la `v` inicial) o None si la respuesta no sirve. Con
    `client=None` arma uno propio.
    """
    propio = client is None
    if propio:
        client = httpx.Client(timeout=TIMEOUT, follow_redirects=False)
    try:
        return _latest_tag(client)
    finally:
        if propio:
            client.close()


def _latest_tag(client: httpx.Client) -> str | None:
    resp = client.get(LATEST_URL, follow_redirects=False)
    # Ojo: `raise_for_status` tambien se queja de los 3xx, asi que el redirect
    # se mira ANTES de validar el status.
    if not resp.is_redirect:
        resp.raise_for_status()
        log.warning("yt-dlp: %s no redirigio (status %s)", LATEST_URL,
                    resp.status_code)
        return None
    tag = _tag_del_location(resp.headers.get("location"))
    if not tag:
        log.warning("yt-dlp: el Location de %s no trae un tag valido (%r)",
                    LATEST_URL, resp.headers.get("location"))
    return tag


def _tag_del_location(location: str | None) -> str | None:
    """Tag extraido de un `Location` tipo `.../releases/tag/<tag>`."""
    if not location or _TAG_EN_LOCATION not in location:
        return None
    resto = location.rsplit(_TAG_EN_LOCATION, 1)[1]
    tag = _tag(resto.split("?", 1)[0].strip("/"))
    if not _TAG_VALIDA.match(tag):
        return None
    return tag


def _consultar(client: httpx.Client, directorio: Path, manifest: dict | None,
               ahora: float) -> str | None:
    remota = _latest_tag(client)
    if not remota:
        log.warning("yt-dlp: no se pudo descubrir la ultima version")
        return None

    cargada = runtime.ytdlp_version()
    pendiente = _version_instalada(manifest)
    if runtime.version_tuple(remota) <= runtime.version_tuple(cargada) \
            or remota == pendiente:
        _guardar(directorio, version=pendiente or cargada,
                 archivo=manifest.get("file") if manifest else None,
                 sha256=manifest.get("sha256") if manifest else None,
                 ahora=ahora)
        log.info("yt-dlp: %s sigue siendo la ultima (en uso: %s)", remota, cargada)
        return None

    url_zip = f"{DOWNLOAD_URL}/{remota}/{ASSET_ZIPAPP}"
    url_sumas = f"{DOWNLOAD_URL}/{remota}/{ASSET_SUMS}"

    esperado = _sha_esperado(client, url_sumas)
    if esperado is None:
        log.warning("yt-dlp: %s no trae la linea de %s", ASSET_SUMS, ASSET_ZIPAPP)
        return None

    temporal = _bajar_y_verificar(client, url_zip, esperado, directorio)
    if temporal is None:
        return None

    destino = directorio / f"yt-dlp-{remota}.zip"
    os.replace(temporal, destino)
    _guardar(directorio, version=remota, archivo=destino.name,
             sha256=esperado, ahora=ahora)
    _podar(directorio, destino)
    log.info("yt-dlp %s lista; se usara en el proximo arranque", remota)
    return remota


def _tag(valor: object) -> str:
    """`tag_name` normalizado: sin una `v` inicial si la trae."""
    texto = str(valor or "").strip()
    if texto[:1] in ("v", "V"):
        texto = texto[1:]
    return texto


def _sha_esperado(client: httpx.Client, url: str) -> str | None:
    resp = client.get(url, follow_redirects=True)
    resp.raise_for_status()
    for linea in resp.text.splitlines():
        partes = linea.split()
        if len(partes) >= 2 and partes[1].lstrip("*") == ASSET_ZIPAPP:
            return partes[0].strip()
    return None


def _bajar_y_verificar(client: httpx.Client, url: str, esperado: str,
                       directorio: Path) -> Path | None:
    """Baja a un temporal del directorio y valida SHA-256 + estructura de zipapp."""
    directorio.mkdir(parents=True, exist_ok=True)
    fd, ruta_tmp = tempfile.mkstemp(dir=directorio, prefix=".yt-dlp-",
                                    suffix=".part")
    temporal = Path(ruta_tmp)
    sha = hashlib.sha256()
    try:
        with os.fdopen(fd, "wb") as f:
            with client.stream("GET", url, follow_redirects=True) as resp:
                resp.raise_for_status()
                for trozo in resp.iter_bytes():
                    f.write(trozo)
                    sha.update(trozo)
    except BaseException:
        _borrar(temporal)
        raise
    if sha.hexdigest().lower() != esperado.lower():
        log.warning("yt-dlp: el SHA-256 no coincide con %s; se descarta",
                    ASSET_SUMS)
        _borrar(temporal)
        return None
    if not _es_zipapp(temporal):
        log.warning("yt-dlp: lo bajado no es un zipapp valido; se descarta")
        _borrar(temporal)
        return None
    return temporal


def _es_zipapp(archivo: Path) -> bool:
    if not zipfile.is_zipfile(archivo):
        return False
    try:
        with zipfile.ZipFile(archivo) as z:
            return "yt_dlp/version.py" in z.namelist()
    except zipfile.BadZipFile:
        return False


def _guardar(directorio: Path, *, version: str | None, archivo: str | None,
             sha256: str | None, ahora: float) -> None:
    """Escribe `current.json` atomico: temporal + `os.replace`."""
    datos = {"version": version, "file": archivo, "sha256": sha256,
             "checked_at": ahora}
    directorio.mkdir(parents=True, exist_ok=True)
    fd, ruta_tmp = tempfile.mkstemp(dir=directorio, prefix=".current-",
                                    suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(datos, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(ruta_tmp, directorio / _MANIFEST)
    except BaseException:
        _borrar(Path(ruta_tmp))
        raise


def _podar(directorio: Path, actual: Path) -> None:
    """Deja el zip actual y el anterior; borra los mas viejos."""
    otros = [p for p in directorio.glob("yt-dlp-*.zip") if p != actual]
    otros.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for viejo in otros[1:]:
        _borrar(viejo)


def _borrar(archivo: Path) -> None:
    try:
        archivo.unlink()
    except OSError:
        pass
