"""Cookies de YouTube: ultimo recurso cuando YouTube pide que verifiques.

Un `cookies.txt` (formato Netscape) exportado de una sesion iniciada es la
unica salida cuando yt-dlp choca con el muro de "confirma que no sos un bot" y
el runtime de JavaScript no alcanza. Se usa SOLO como reintento, nunca en el
primer intento: andar con cuenta tiene riesgo de bloqueo.

El archivo se guarda bajo el directorio de datos de la app, reusando el mismo
protector que los tokens de nube (`cloud/tokens.py`): DPAPI en Windows, o el
archivo con permisos 0600 en el resto. El contenido es un sobre JSON con la
fecha de importacion, la cantidad de cookies y el texto filtrado.

Al importar se valida y se FILTRA: una exportacion trae las cookies de TODOS
los sitios y aca solo se guardan las de youtube.com/google.com.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .cloud.tokens import Protector, default_data_dir, default_protector

log = logging.getLogger("spitifo.youtube")

#: Tope del archivo subido: un cookies.txt real pesa unos pocos KB.
MAX_BYTES = 1024 * 1024

#: Cabecera que espera el parser de Netscape (http.cookiejar la exige).
_HEADER = "# Netscape HTTP Cookie File"
_HTTPONLY = "#HttpOnly_"

#: Archivo del sobre protegido dentro del directorio de datos.
_COOKIES_NAME = "cookies.bin"


class CookieImportError(ValueError):
    """El archivo no sirve como cookies de YouTube. El mensaje va a la UI."""


def default_cookies_path() -> Path:
    """Ruta del sobre de cookies (se resuelve en cada llamada, no al importar).

    Asi `SPITIFO_DATA_DIR` (que en los tests apunta a un temporal) vale siempre.
    """
    return default_data_dir() / "youtube" / _COOKIES_NAME


# --------------------------------------------------------------- validacion
def _es_cookie(linea: str) -> tuple[list[str], str] | None:
    """`(campos, linea_original)` si la linea es una cookie de 7 campos.

    Acepta comentarios con `#HttpOnly_` (los que escribe yt-dlp para cookies
    HttpOnly) y descarta cualquier otro `#` y las lineas vacias.
    """
    cruda = linea.rstrip("\r")
    s = cruda
    if cruda.startswith(_HTTPONLY):
        s = cruda[len(_HTTPONLY):]
    elif cruda.lstrip().startswith("#"):
        return None
    if not s.strip():
        return None
    campos = s.split("\t")
    if len(campos) != 7:
        return None
    return campos, cruda


def _dominio_guardado(dominio: str) -> bool:
    """True solo para youtube.com y google.com (con sus subdominios)."""
    dom = dominio.strip().lstrip(".").lower()
    return (dom == "youtube.com" or dom.endswith(".youtube.com")
            or dom == "google.com" or dom.endswith(".google.com"))


def filter_cookies(raw: bytes) -> tuple[str, int]:
    """Valida y filtra un cookies.txt crudo. Devuelve `(texto, cantidad)`.

    Lanza `CookieImportError` con un motivo legible si el archivo no sirve.
    """
    if len(raw) > MAX_BYTES:
        raise CookieImportError(
            f"el archivo supera el maximo de {MAX_BYTES // 1024} KiB")
    try:
        texto = raw.decode("utf-8")
    except UnicodeDecodeError:
        texto = raw.decode("latin-1", errors="replace")

    lineas = texto.splitlines()
    tiene_header = any(l.startswith(_HEADER) for l in lineas)

    conservadas: list[str] = []
    total = 0
    for linea in lineas:
        parsed = _es_cookie(linea)
        if parsed is None:
            continue
        campos, cruda = parsed
        total += 1
        if _dominio_guardado(campos[0]):
            conservadas.append(cruda)

    if total == 0:
        raise CookieImportError(
            "no parece un cookies.txt (formato Netscape) o esta vacio")
    if not conservadas:
        raise CookieImportError("el archivo no tiene cookies de YouTube")
    if not tiene_header:
        # Sin cabecera igual se acepta, pero la salida SIEMPRE la lleva: el
        # parser de Netscape no carga un archivo sin ella.
        log.info("cookies de YouTube: el archivo no traia cabecera Netscape")

    salida = "\n".join([_HEADER, *conservadas]) + "\n"
    return salida, len(conservadas)


# ------------------------------------------------------------------ guardado
class CookieStore:
    """Sobre protegido en disco: fecha, cantidad y texto filtrado."""

    def __init__(self, path: Path | None = None,
                 protector: Protector | None = None) -> None:
        self.path = Path(path) if path is not None else default_cookies_path()
        self.protector = protector or default_protector()

    def load(self) -> dict | None:
        """Contenido del sobre, o None si no esta o no se puede descifrar."""
        try:
            data = json.loads(
                self.protector.unprotect(self.path.read_bytes()).decode("utf-8"))
        except Exception:
            return None
        if not isinstance(data, dict) or not isinstance(data.get("cookies"), str):
            return None
        return data

    def text(self) -> str | None:
        """Texto Netscape plano, o None si no hay cookies importadas."""
        data = self.load()
        return data["cookies"] if data else None

    def status(self) -> dict:
        """Estado para la UI. Nunca incluye el contenido de las cookies."""
        data = self.load()
        return {
            "configured": data is not None,
            "imported_at": (data or {}).get("imported_at"),
            "count": int((data or {}).get("count") or 0),
        }

    def import_bytes(self, raw: bytes) -> dict:
        """Valida, filtra y guarda. Devuelve el estado resultante."""
        texto, count = filter_cookies(raw)
        self._write({
            "imported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "count": count,
            "cookies": texto,
        })
        log.info("cookies de YouTube importadas: %d", count)
        return self.status()

    def import_text(self, text: str) -> dict:
        return self.import_bytes(text.encode("utf-8"))

    def _write(self, data: dict) -> None:
        """Escritura atomica, igual que `TokenStore.save`."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        raw = self.protector.protect(json.dumps(data).encode("utf-8"))
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".cookies-",
                                   suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
                f.flush()
                os.fsync(f.fileno())
            if sys.platform != "win32":
                # Sin DPAPI la unica proteccion es el permiso del archivo.
                os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def remove(self) -> None:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


# ----------------------------------------------------------- API del modulo
# Cada llamada resuelve la ruta de nuevo: `SPITIFO_DATA_DIR` puede cambiar
# (tests) y no queremos congelar el protector al importar el modulo.

def status() -> dict:
    return CookieStore().status()


def import_bytes(raw: bytes) -> dict:
    return CookieStore().import_bytes(raw)


def load_text() -> str | None:
    return CookieStore().text()


def remove() -> None:
    CookieStore().remove()


@contextmanager
def plaintext_tempfile(text: str, directory: Path) -> Iterator[Path]:
    """Copia plana 0600 en una subcarpeta temporal; se borra al salir.

    yt-dlp necesita un `cookiefile` en disco: esto es lo unico que se escribe
    en claro, dentro de la particion privada (`SPITIFO_TEMP_DIR`) y por el
    tiempo de un intento. Nunca se loguea el contenido.
    """
    tmpdir = Path(tempfile.mkdtemp(dir=directory))
    try:
        destino = tmpdir / "cookies.txt"
        fd = os.open(str(destino), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        yield destino
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
