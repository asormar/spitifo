"""Descarga yt-dlp: reintentos, formato "original" y yt-dlp reemplazable.

Todo OFFLINE. `download()` hace `import yt_dlp` perezoso, asi que alcanza con
poner un doble en `sys.modules` (mismo truco que test_descargas_concurrentes).

Cubre:
- `is_transient_error`: que se reintenta y que no (funcion pura).
- `YtDlpSource.download`: un 403 y despues exito => "done" con 2 intentos; un
  error permanente => 1 solo intento; el job no pasa por "error" entre intentos.
- `postprocessor_opts` / `pick_output`: "original" => preferredcodec "best" y
  encuentra el archivo (.opus, .m4a...) que dejo yt-dlp.
- `SPITIFO_YTDLP_DIR`: un yt_dlp en esa carpeta (o zip) gana sobre el instalado.
  Corre en un SUBPROCESO: en este proceso yt_dlp ya esta importado.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import types
import zipfile
from pathlib import Path

import pytest

from backend.app import ytdlp_source as ys
from backend.app.models import Track
from backend.app.ytdlp_source import (
    is_transient_error,
    pick_output,
    postprocessor_opts,
)

RAIZ = Path(__file__).resolve().parents[1]


# ------------------------------------------------------- is_transient_error
@pytest.mark.parametrize("mensaje", [
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
    "HTTP Error 429: Too Many Requests",
    "ERROR: unable to download video data: HTTP Error 500: Internal Server Error",
    "HTTP Error 502: Bad Gateway",
    "HTTP Error 503: Service Unavailable",
    "<urlopen error [Errno 104] Connection reset by peer>",
    "('Connection aborted.', ConnectionResetError(10054, 'forcibly closed'))",
    "The read operation timed out",
    "Read timed out. (read timeout=60)",
    "Remote end closed connection without response",
])
def test_errores_transitorios_se_reintentan(mensaje):
    assert is_transient_error(mensaje) is True
    assert is_transient_error(RuntimeError(mensaje)) is True


@pytest.mark.parametrize("mensaje", [
    "ERROR: [youtube] abc: Video unavailable",
    "ERROR: [youtube] abc: Private video. Sign in if you've been granted access",
    "ERROR: [youtube] abc: Sign in to confirm you're not a bot",
    "ERROR: Requested format is not available. Use --list-formats",
    "ERROR: Unsupported URL: https://example.org/x",
    # DNS: el telefono sin red no se arregla esperando 1 s
    "<urlopen error [Errno 7] No address associated with hostname>",
    "<urlopen error [Errno 11001] getaddrinfo failed>",
    "<urlopen error [Errno -2] Name or service not known>",
    # permanente aunque el mensaje mencione tambien un 403
    "ERROR: This video is unavailable (HTTP Error 403: Forbidden)",
    "HTTP Error 404: Not Found",
    "HTTP Error 401: Unauthorized",
    "algo que no tiene nada que ver",
    "",
])
def test_errores_permanentes_no_se_reintentan(mensaje):
    assert is_transient_error(mensaje) is False


def test_errores_de_red_nativos_son_transitorios():
    assert is_transient_error(ConnectionResetError()) is True
    assert is_transient_error(TimeoutError()) is True
    assert is_transient_error(ValueError("falta webpage_url")) is False


# --------------------------------------------------------------------- dobles
class DownloadError(Exception):
    """Mismo nombre que la de yt-dlp; el clasificador solo mira el mensaje."""


class YtDlpFalso:
    """`yt_dlp.YoutubeDL` que falla segun un guion y luego "descarga".

    `guion` es una lista: cada elemento es una excepcion a lanzar o None para
    exito. Se consume un elemento por intento. Guarda los `opts` y el estado del
    job que veia al empezar cada intento.
    """

    guion: list = []
    intentos = 0
    opts_vistas: list[dict] = []
    estados_al_empezar: list[str] = []
    job_id: str | None = None
    ext_salida = "mp3"
    devolver_filepath = True

    def __init__(self, opts):
        self.opts = opts
        type(self).opts_vistas.append(opts)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=True):
        tipo = type(self)
        tipo.intentos += 1
        tipo.estados_al_empezar.append(ys.JOBS[tipo.job_id]["status"])
        paso = tipo.guion.pop(0) if tipo.guion else None
        if paso is not None:
            raise paso
        # outtmpl RELATIVO: el destino real lo fija paths.home (la subcarpeta de
        # trabajo del job), igual que hace yt-dlp de verdad.
        opts = self.opts
        rel = opts["outtmpl"].replace("%(ext)s", tipo.ext_salida)
        destino = Path((opts.get("paths") or {})["home"]) / rel
        destino.parent.mkdir(parents=True, exist_ok=True)
        with open(destino, "wb") as f:
            f.write(b"\x00" * 512)
        return {"filepath": str(destino) if tipo.devolver_filepath else None,
                "title": "Cancion de prueba", "uploader": "Artista",
                "duration": 10}


@pytest.fixture
def yt_dlp_falso(monkeypatch):
    mod = types.ModuleType("yt_dlp")
    mod.YoutubeDL = YtDlpFalso
    monkeypatch.setitem(sys.modules, "yt_dlp", mod)
    # sin esperas reales entre intentos
    monkeypatch.setattr(ys, "RETRY_DELAYS_S", (0.0, 0.0))
    YtDlpFalso.guion = []
    YtDlpFalso.intentos = 0
    YtDlpFalso.opts_vistas = []
    YtDlpFalso.estados_al_empezar = []
    YtDlpFalso.ext_salida = "mp3"
    YtDlpFalso.devolver_filepath = True
    ys._LOCKS_POR_RUTA.clear()
    yield YtDlpFalso
    ys._LOCKS_POR_RUTA.clear()


def _bajar(titulo: str, fmt: str = "mp3") -> tuple[dict, str]:
    """Corre `download()` y devuelve (resultado, job_id). Puede lanzar."""
    track = Track(source="ytdlp", source_id="yt-r", title=titulo,
                  artist="Reintentos", extra={"webpage_url": "https://youtu.be/abc"})
    job_id = ys.new_job(titulo)
    YtDlpFalso.job_id = job_id
    res = asyncio.run(ys.YtDlpSource().download(track, fmt, job_id=job_id))
    return res, job_id


# ------------------------------------------------------------------ reintentos
def test_un_403_y_despues_exito_termina_done_con_2_intentos(yt_dlp_falso, tmp_path,
                                                            storage_temporal):
    st = storage_temporal(tmp_path / "lib")
    yt_dlp_falso.guion = [
        DownloadError("ERROR: unable to download video data: HTTP Error 403: Forbidden"),
    ]
    res, job_id = _bajar("Un 403")

    assert yt_dlp_falso.intentos == 2
    job = ys.get_job(job_id)
    assert job["status"] == "done"
    assert "error" not in job
    # entre intentos el job sigue "downloading": nunca paso por "error"
    assert yt_dlp_falso.estados_al_empezar == ["downloading", "downloading"]
    assert res["format"] == "MP3"
    assert st.stat(res["key"]).size > 0
    assert job["key"] == res["key"]


def test_reintenta_hasta_3_veces_y_recien_despues_es_error(yt_dlp_falso):
    yt_dlp_falso.guion = [DownloadError("HTTP Error 403: Forbidden")] * 3
    with pytest.raises(RuntimeError, match="403"):
        _bajar("Siempre 403")

    assert yt_dlp_falso.intentos == 3
    # los dos primeros fallos no marcaron error: el estado visto fue siempre
    # "downloading" al empezar cada intento
    assert yt_dlp_falso.estados_al_empezar == ["downloading"] * 3
    job = ys.get_job(YtDlpFalso.job_id)
    assert job["status"] == "error"
    assert "403" in job["error"]


@pytest.mark.parametrize("mensaje", [
    "ERROR: [youtube] abc: Video unavailable",
    "<urlopen error [Errno 7] No address associated with hostname>",
    "ERROR: Requested format is not available",
])
def test_un_error_permanente_se_intenta_una_sola_vez(yt_dlp_falso, mensaje):
    yt_dlp_falso.guion = [DownloadError(mensaje)] * 3
    with pytest.raises(RuntimeError):
        _bajar("Permanente")

    assert yt_dlp_falso.intentos == 1
    assert ys.get_job(YtDlpFalso.job_id)["status"] == "error"


def test_el_reintento_resetea_el_progreso_del_job(yt_dlp_falso):
    """Un intento a medias dejo progreso>0: el siguiente arranca de cero."""
    ys_job = {}

    class ConProgreso(YtDlpFalso):
        def extract_info(self, url, download=True):
            if not type(self).intentos:  # primer intento: avanza y se corta
                with ys._JOBS_LOCK:
                    ys.JOBS[YtDlpFalso.job_id].update(progress=63.0, speed=1.0)
            else:
                ys_job.update(ys.JOBS[YtDlpFalso.job_id])
            return super().extract_info(url, download)

    sys.modules["yt_dlp"].YoutubeDL = ConProgreso
    ConProgreso.guion = [DownloadError("HTTP Error 503: Service Unavailable")]
    _bajar("Con progreso")
    assert ys_job["progress"] == 0.0
    assert ys_job["speed"] is None


# ---------------------------------------------------------- formato "original"
@pytest.mark.parametrize("fmt,codec", [
    ("original", "best"),
    ("mp3", "mp3"),
    ("m4a", "m4a"),
    ("cualquier-otra-cosa", "mp3"),  # comportamiento de siempre
])
def test_postprocessor_opts_por_formato(fmt, codec):
    pps = postprocessor_opts(fmt)
    assert len(pps) == 1
    assert pps[0]["key"] == "FFmpegExtractAudio"
    assert pps[0]["preferredcodec"] == codec


@pytest.mark.parametrize("fmt,codec", [("original", "best"), ("mp3", "mp3"), ("m4a", "m4a")])
def test_download_pasa_el_codec_correcto_a_yt_dlp(yt_dlp_falso, fmt, codec):
    _bajar(f"Codec {fmt}", fmt)
    pps = yt_dlp_falso.opts_vistas[0]["postprocessors"]
    assert pps[0]["preferredcodec"] == codec


@pytest.mark.parametrize("ext", ["opus", "m4a", "ogg"])
def test_original_encuentra_el_archivo_con_su_extension_natural(yt_dlp_falso, ext,
                                                                tmp_path,
                                                                storage_temporal):
    """yt-dlp no devuelve `filepath` tras el postprocess: el glob lo encuentra."""
    st = storage_temporal(tmp_path / "lib")
    yt_dlp_falso.ext_salida = ext
    yt_dlp_falso.devolver_filepath = False
    res, job_id = _bajar(f"Original {ext}", "original")
    assert res["format"] == ext.upper()
    assert Path(res["key"]).suffix == "." + ext
    assert st.stat(res["key"]).size > 0
    assert ys.get_job(job_id)["status"] == "done"


def _tocar(carpeta: Path, nombre: str, mtime: float) -> Path:
    p = carpeta / nombre
    p.write_bytes(b"x")
    os.utime(p, (mtime, mtime))
    return p


def test_pick_output_original_prefiere_audio_y_lo_mas_reciente(tmp_path):
    webm = _tocar(tmp_path, "a.webm", 300)      # intermedio, no es audio final
    viejo = _tocar(tmp_path, "a.mp3", 100)      # de una descarga anterior
    nuevo = _tocar(tmp_path, "a.opus", 200)
    assert pick_output([webm, viejo, nuevo], "original") == nuevo
    assert pick_output([webm], "original") == webm  # mejor eso que nada
    assert pick_output([], "original") is None


def test_pick_output_respeta_el_formato_pedido(tmp_path):
    mp3 = _tocar(tmp_path, "a.mp3", 100)
    m4a = _tocar(tmp_path, "a.m4a", 200)
    assert pick_output([mp3, m4a], "mp3") == mp3
    assert pick_output([mp3, m4a], "m4a") == m4a


def test_toda_extension_que_puede_producir_yt_dlp_esta_en_AUDIO_EXTS():
    from yt_dlp.postprocessor.ffmpeg import ACODECS

    from backend.app.config import AUDIO_EXTS

    producidas = {"." + ext for ext, _codec, _opts in ACODECS.values()}
    assert producidas <= set(AUDIO_EXTS)


def test_library_scan_lista_audio_y_video(tmp_path, storage_temporal):
    """`library_scan` lista audio y VIDEO (el `.webm` ya no se descarta), y
    marca cada entrada con su `kind`. Lo que no es media (.txt) sigue afuera."""
    import backend.app.downloader as dl

    storage_temporal(tmp_path)
    (tmp_path / "Artista").mkdir()
    for nombre in ("a.opus", "b.ogg", "c.m4a", "d.webm", "notas.txt"):
        (tmp_path / "Artista" / nombre).write_bytes(b"\x00" * 64)
    archivos = dl.library_scan()
    assert sorted(f["filename"] for f in archivos) == [
        "a.opus", "b.ogg", "c.m4a", "d.webm"]
    kinds = {f["filename"]: f["kind"] for f in archivos}
    assert kinds["d.webm"] == "video"
    assert kinds["a.opus"] == "audio"
    assert all(f["key"].startswith("Artista/") for f in archivos)


# ------------------------------------------------------------ SPITIFO_YTDLP_DIR
_VERSION_FALSA = "9999.99.99"
_CODIGO_HIJO = (
    "from starlette.testclient import TestClient\n"
    "from backend.app.main import app\n"
    "r = TestClient(app).get('/api/health')\n"
    "print('VERSION=' + str(r.json()['ytdlp_version']))\n"
)


def _paquete_falso(destino: Path) -> Path:
    pkg = destino / "yt_dlp"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "version.py").write_text(
        f"__version__ = '{_VERSION_FALSA}'\n", encoding="utf-8")
    return destino


def _version_en_subproceso(ytdlp_dir: str | None, tmp_path: Path) -> str:
    env = {k: v for k, v in os.environ.items()
           if k not in ("SPITIFO_YTDLP_DIR", "SPITIFO_TOKEN", "YTDLP_ENABLED")}
    env["SPITIFO_LIBRARY"] = str(tmp_path / "lib")
    if ytdlp_dir is not None:
        env["SPITIFO_YTDLP_DIR"] = ytdlp_dir
    r = subprocess.run([sys.executable, "-c", _CODIGO_HIJO], cwd=RAIZ, env=env,
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    linea = next(l for l in r.stdout.splitlines() if l.startswith("VERSION="))
    return linea.removeprefix("VERSION=")


def test_ytdlp_dir_con_carpeta_gana_sobre_el_instalado(tmp_path):
    carpeta = _paquete_falso(tmp_path / "nuevo")
    assert _version_en_subproceso(str(carpeta), tmp_path) == _VERSION_FALSA


def test_ytdlp_dir_con_zip_gana_sobre_el_instalado(tmp_path):
    origen = _paquete_falso(tmp_path / "src")
    archivo = tmp_path / "yt-dlp"  # el zip oficial se llama asi, sin extension
    with zipfile.ZipFile(archivo, "w") as z:
        for f in (origen / "yt_dlp").iterdir():
            z.write(f, f"yt_dlp/{f.name}")
    assert _version_en_subproceso(str(archivo), tmp_path) == _VERSION_FALSA


def test_ytdlp_dir_inexistente_se_ignora(tmp_path):
    version = _version_en_subproceso(str(tmp_path / "no-existe"), tmp_path)
    assert version not in (_VERSION_FALSA, "None")


def test_health_informa_la_version_de_ytdlp(cliente):
    v = cliente.get("/api/health").json()["ytdlp_version"]
    assert v is None or (isinstance(v, str) and v)
    # y no rompe las claves de siempre
    assert {"ok", "sources", "library"} <= set(cliente.get("/api/health").json())


def test_setup_ytdlp_dir_es_idempotente(tmp_path, monkeypatch):
    from backend.app.runtime import setup_ytdlp_dir

    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(tmp_path))
    assert setup_ytdlp_dir() is True
    assert sys.path[0] == str(tmp_path)
    assert setup_ytdlp_dir() is False
    assert sys.path.count(str(tmp_path)) == 1
    monkeypatch.delenv("SPITIFO_YTDLP_DIR")
    assert setup_ytdlp_dir() is False
