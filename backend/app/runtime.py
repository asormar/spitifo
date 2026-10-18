"""Ajustes de entorno que el backend hace una sola vez, al arrancar.

Existe por dos cosas que en el escritorio no hacen falta pero al embeber el
backend sí (Tauri en Windows, Chaquopy/WebView en Android):

1. **ffmpeg inyectable.** En Android ffmpeg/ffprobe no están en el `PATH` del
   sistema: los trae la app y viven en su directorio de librerías nativas.
   `SPITIFO_FFMPEG_DIR` deja apuntar ahí y el resto del backend (que no cambia)
   los encuentra con `shutil.which`.
2. **MIME de audio.** Android no tiene base de datos MIME del sistema, así que
   `mimetypes.guess_type(".ogg")` devolvía `None` y `FileResponse` servía el
   archivo como `application/octet-stream`: el `<audio>` no lo reconocía.

3. **yt-dlp reemplazable.** YouTube rompe yt-dlp varias veces al año y en Android
   no hay `pip`. `SPITIFO_YTDLP_DIR` apunta a una carpeta (con `yt_dlp/` adentro)
   o al zip oficial de yt-dlp; va al frente de `sys.path` y gana sobre el que
   viene empaquetado. Quien baja las versiones nuevas es `ytdlp_update.py`, que
   deja el zip y un `current.json` en el directorio de actualizacion; acá se lee
   ese manifest y se carga el zip (zipimport necesita la ruta del zip), pero
   SOLO si ese zip es mas nuevo que el yt-dlp empaquetado: nunca se baja de
   version (`bundled_ytdlp_version` lo resuelve sin importar el paquete).

Nada de acá importa starlette ni uvicorn: es un módulo neutral.
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import logging
import mimetypes
import os
import re
import sys
from pathlib import Path

log = logging.getLogger("spitifo.runtime")

# Tipos que el navegador/WebView tiene que reconocer para poder reproducir sin
# descargar. `.opus` va como audio/ogg: es un flujo Ogg y es lo que espera el
# motor de audio de Chromium.
AUDIO_MIME_TYPES = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
}


def prepend_to_path(directory: str) -> bool:
    """Pone `directory` al frente de `PATH`, una sola vez.

    Devuelve True si lo agregó y False si ya estaba (o si `directory` es
    vacío). Es idempotente a propósito: arrancar el backend dos veces en el
    mismo proceso no tiene que llenar el PATH de copias.
    """
    if not directory:
        return False
    partes = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    if directory in partes:
        return False
    os.environ["PATH"] = os.pathsep.join([directory, *partes])
    return True


def setup_ffmpeg_dir() -> bool:
    """Aplica `SPITIFO_FFMPEG_DIR` al PATH. False si la variable no está."""
    return prepend_to_path(os.getenv("SPITIFO_FFMPEG_DIR", ""))


def setup_ytdlp_dir() -> bool:
    """Pone al frente de `sys.path` la version de yt-dlp que hay que usar.

    Dos fuentes, en este orden:

    1. El zip que bajo `ytdlp_update.py`: si el directorio de actualizacion
       tiene un `current.json` valido cuyo archivo existe y cuyo SHA-256
       coincide, se inserta la RUTA DEL ZIP (zipimport importa zips desde
       `sys.path`). El zip solo se usa si es MAS NUEVO que el yt-dlp
       empaquetado: nunca se baja de version. Si el archivo no esta, el hash no
       da o el zip no aporta, se avisa y se sigue.
    2. `SPITIFO_YTDLP_DIR`: una carpeta con `yt_dlp/` adentro o el zip oficial,
       comportamiento de siempre.

    Devuelve False si no habia nada que insertar (o si ya estaba al frente).
    Tiene que correr ANTES del primer `import yt_dlp`: con el módulo ya cargado,
    el reemplazo no tendría efecto.
    """
    base = ytdlp_update_dir()
    manifest = read_ytdlp_manifest(base)
    if manifest:
        archivo = _manifest_zip(base, manifest)
        if archivo is not None and _zip_supera_al_empaquetado(manifest):
            return _insert_zip(archivo)
    return _setup_ytdlp_dir_plano()


#: `__version__ = "2026.10.18"` en `yt_dlp/version.py`.
_VERSION_RE = re.compile(r"""^\s*__version__\s*=\s*['"]([^'"]+)['"]""",
                         re.MULTILINE)


def version_tuple(version: str | None) -> tuple[int, ...]:
    """Version a tupla de ints para comparar. Los tramos no numericos son 0."""
    partes: list[int] = []
    for trozo in str(version or "").split("."):
        try:
            partes.append(int(trozo))
        except ValueError:
            partes.append(0)
    return tuple(partes)


def bundled_ytdlp_version() -> str | None:
    """Version del yt-dlp empaquetado, sin importarlo y sin el zip de update.

    Se resuelve con `importlib.util.find_spec`, que ubica el paquete pero NO lo
    ejecuta; por eso hay que llamarla ANTES de meter el zip en `sys.path` (si
    no, encontraria el zip y no el empaquetado). Del `spec.origin` sale la ruta
    de `__init__.py`; el `version.py` hermano trae `__version__`. En binarios
    congelados (PyInstaller) o zips (zipimport) el archivo no esta en disco y se
    pide por `spec.loader.get_data`. Cualquier falla devuelve None.
    """
    try:
        spec = importlib.util.find_spec("yt_dlp")
    except Exception as exc:
        log.warning("yt-dlp: no se pudo resolver el paquete empaquetado (%s)", exc)
        return None
    if spec is None or not spec.origin:
        return None
    try:
        texto = _version_py_texto(spec, spec.origin)
    except Exception as exc:
        log.warning("yt-dlp: no se pudo leer la version empaquetada (%s)", exc)
        return None
    encontrado = _VERSION_RE.search(texto) if texto else None
    if encontrado:
        return encontrado.group(1)
    # PyInstaller guarda yt-dlp compilado en el PYZ, sin `version.py`: queda la
    # metadata del paquete instalado (el spec la incluye con copy_metadata). El
    # zip del actualizador no trae dist-info, asi que esto siempre es el
    # empaquetado.
    try:
        from importlib import metadata
        return metadata.version("yt-dlp")
    except Exception:
        return None


def _version_py_texto(spec: object, origen: str) -> str | None:
    """Texto de `version.py` (hermano de `__init__.py`), del disco o del loader."""
    ruta = Path(origen).with_name("version.py")
    try:
        if ruta.is_file():
            return ruta.read_text(encoding="utf-8", errors="replace")
    except OSError:
        pass
    # Empaquetado: el archivo no esta en disco, pero el loader lo puede leer.
    obtener = getattr(getattr(spec, "loader", None), "get_data", None)
    if obtener is None:
        return None
    for candidato in _rutas_get_data(origen):
        try:
            datos = obtener(candidato)
        except Exception:
            continue
        if datos:
            return datos.decode("utf-8", errors="replace")
    return None


def _rutas_get_data(origen: str) -> list[str]:
    """Rutas con las que pedir `version.py` a un loader (absoluta y relativa)."""
    normalizado = origen.replace("\\", "/")
    rutas: list[str] = []
    if "/" in normalizado:
        rutas.append(f"{normalizado.rsplit('/', 1)[0]}/version.py")
    marca = normalizado.find("yt_dlp/")
    if marca >= 0:
        relativa = normalizado[marca:]  # yt_dlp/__init__.py
        rutas.append(f"{relativa.rsplit('/', 1)[0]}/version.py")
    return rutas


def _zip_supera_al_empaquetado(manifest: dict) -> bool:
    """True si el zip del manifest es mas nuevo que el yt-dlp empaquetado.

    Si no se puede saber la version empaquetada (None), se confia en el zip: es
    lo unico que hay. Si el empaquetado es igual o mas nuevo, el zip no aporta.
    """
    empaquetada = bundled_ytdlp_version()
    declarada = manifest.get("version")
    if empaquetada is None or not declarada:
        return True
    if version_tuple(str(declarada)) > version_tuple(empaquetada):
        return True
    log.info("yt-dlp: el zip %s (%s) no supera al empaquetado (%s): se ignora",
             manifest.get("file"), declarada, empaquetada)
    return False


def ytdlp_update_dir() -> Path:
    """Carpeta donde el actualizador guarda los zip de yt-dlp.

    `SPITIFO_YTDLP_DIR` si esta seteada; si no, el directorio de datos de la app
    (el mismo que usan los tokens y que en Android apunta al almacenamiento
    propio de la app).
    """
    override = os.getenv("SPITIFO_YTDLP_DIR", "")
    if override:
        return Path(override)
    # Import perezoso: asi este modulo neutral no arrastra httpx salvo que haga
    # falta resolver la ruta por defecto.
    from .cloud.tokens import default_data_dir
    return default_data_dir() / "yt-dlp"


def read_ytdlp_manifest(directory: Path | None = None) -> dict | None:
    """Lee `current.json` del directorio de actualizacion.

    None si no existe, no se puede leer o no es un objeto JSON: quien llama
    trata los tres casos igual (no hay version pendiente).
    """
    base = Path(directory) if directory is not None else ytdlp_update_dir()
    try:
        data = json.loads((base / "current.json").read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for trozo in iter(lambda: f.read(1024 * 1024), b""):
            h.update(trozo)
    return h.hexdigest()


def _manifest_zip(base: Path, manifest: dict) -> Path | None:
    """Ruta del zip que declara el manifest, si existe y el SHA-256 coincide."""
    nombre = manifest.get("file")
    esperado = manifest.get("sha256")
    if not nombre or not esperado:
        return None
    archivo = base / str(nombre)
    if not archivo.is_file():
        log.warning("yt-dlp: el manifest apunta a un archivo que no esta: %s",
                    archivo)
        return None
    try:
        real = _sha256_file(archivo)
    except OSError as exc:
        log.warning("yt-dlp: no se pudo leer el zip del manifest (%s)", exc)
        return None
    if real.lower() != str(esperado).lower():
        log.warning("yt-dlp: el SHA-256 de %s no coincide con el manifest",
                    archivo.name)
        return None
    return archivo


def _insert_zip(archivo: Path) -> bool:
    """Inserta el zipapp y comprueba que se pueda importar.

    Si `import yt_dlp` falla, se deshace: se saca la ruta, se purgan los modulos
    `yt_dlp*` de `sys.modules` y se sigue con el yt-dlp empaquetado.
    """
    ruta = str(archivo)
    if sys.path and sys.path[0] == ruta:
        return False
    if "yt_dlp" in sys.modules:
        log.warning("yt_dlp ya estaba importado: el zip nuevo no lo reemplaza")
    sys.path.insert(0, ruta)
    importlib.invalidate_caches()
    try:
        import yt_dlp  # noqa: F401
    except Exception as exc:
        log.warning("yt-dlp: el zip %s no se puede importar (%s): se usa el "
                    "empaquetado", archivo.name, exc)
        _descartar_zip(ruta)
        return False
    return True


def _descartar_zip(ruta: str) -> None:
    try:
        sys.path.remove(ruta)
    except ValueError:
        pass
    for nombre in [m for m in sys.modules
                   if m == "yt_dlp" or m.startswith("yt_dlp.")]:
        del sys.modules[nombre]
    importlib.invalidate_caches()


def _setup_ytdlp_dir_plano() -> bool:
    """`SPITIFO_YTDLP_DIR` a secas: una carpeta con `yt_dlp/` o el zip oficial."""
    ruta = os.getenv("SPITIFO_YTDLP_DIR", "")
    if not ruta:
        return False
    if not os.path.exists(ruta):
        log.warning("SPITIFO_YTDLP_DIR no existe: %s", ruta)
        return False
    if sys.path and sys.path[0] == ruta:
        return False
    if "yt_dlp" in sys.modules:
        log.warning("yt_dlp ya estaba importado: SPITIFO_YTDLP_DIR no lo reemplaza")
    sys.path.insert(0, ruta)
    importlib.invalidate_caches()
    return True


def ytdlp_version() -> str | None:
    """Version de yt-dlp que se esta usando de verdad, o None si no se importa.

    No se cachea: tras el primer import es un lookup en sys.modules, y asi el
    valor siempre refleja el modulo que esta cargado.
    """
    try:
        from yt_dlp import version
        return str(version.__version__)
    except Exception:
        return None


def register_audio_mime_types() -> None:
    """Registra los MIME de audio en la base global de `mimetypes`."""
    for ext, mime in AUDIO_MIME_TYPES.items():
        mimetypes.add_type(mime, ext)


def configure_runtime() -> None:
    """Todo lo que hay que dejar listo antes de servir la primera request."""
    register_audio_mime_types()
    setup_ffmpeg_dir()
    setup_ytdlp_dir()
