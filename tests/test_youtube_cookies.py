"""Cookies de YouTube: importacion, guardado protegido, API y reintento.

Todo OFFLINE y en un directorio de datos temporal (`SPITIFO_DATA_DIR`, que
conftest ya redirige). Cubre:

- validacion del cookies.txt (bueno, sin YouTube -> 422, > 1 MiB -> 422) y el
  filtrado de dominios (solo youtube.com/google.com se guardan);
- los endpoints GET/POST/DELETE;
- el reintento UNICO ante el muro de verificacion, con un `YoutubeDL` doble:
  la copia plana del cookiefile existe durante el intento, y se borra despues;
- sin cookies: error con codigo `youtube_bot_check`; sin muro: ni un reintento;
- round trip de cifrado DPAPI, solo en Windows.
"""
from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path

import pytest

from backend.app import youtube_cookies as yc
from backend.app.cloud import tokens as tokens_mod

RAIZ = Path(__file__).resolve().parents[1]


def _cookies_txt(dominios=("youtube.com", "example.org")) -> bytes:
    lineas = ["# Netscape HTTP Cookie File"]
    for dom in dominios:
        lineas.append(f".{dom}\tTRUE\t/\tTRUE\t0\t__Secure-1PSID\tSECRETO-{dom}")
    lineas.append("")
    return "\n".join(lineas).encode("utf-8")


# ------------------------------------------------------------- validacion
def test_importa_un_cookies_txt_valido(tmp_path, monkeypatch):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    info = yc.import_bytes(_cookies_txt(("youtube.com", "google.com")))
    assert info["configured"] is True
    assert info["count"] == 2
    assert info["imported_at"]
    texto = yc.load_text()
    assert texto.startswith("# Netscape HTTP Cookie File")
    assert "youtube.com" in texto and "google.com" in texto


def test_filtra_los_dominios_que_no_son_youtube_ni_google(tmp_path, monkeypatch):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    info = yc.import_bytes(_cookies_txt(("youtube.com", "google.com", "example.org")))
    assert info["count"] == 2
    texto = yc.load_text()
    assert "example.org" not in texto
    assert "SECRETO-youtube.com" in texto


def test_acepta_lineas_sin_cabecera_y_httponly(tmp_path, monkeypatch):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    crudo = (b"#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalor\n")
    info = yc.import_bytes(crudo)
    assert info["configured"] is True and info["count"] == 1
    assert yc.load_text().startswith("# Netscape HTTP Cookie File")


def test_sin_youtube_falla(tmp_path, monkeypatch):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    with pytest.raises(yc.CookieImportError):
        yc.import_bytes(_cookies_txt(("example.org",)))


def test_basura_falla(tmp_path, monkeypatch):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    with pytest.raises(yc.CookieImportError):
        yc.import_bytes(b"esto no es un cookies.txt\nnada de nada\n")


def test_archivo_demasiado_grande_falla(tmp_path, monkeypatch):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    with pytest.raises(yc.CookieImportError):
        yc.import_bytes(b"x" * (yc.MAX_BYTES + 1))


# ------------------------------------------------------------------ API
def test_endpoints_get_post_delete(tmp_path, monkeypatch, cliente):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))

    assert cliente.get("/api/youtube/cookies").json() == {
        "configured": False, "imported_at": None, "count": 0}

    r = cliente.post("/api/youtube/cookies",
                     files={"file": ("cookies.txt", _cookies_txt(), "text/plain")})
    assert r.status_code == 200
    d = r.json()
    assert d["configured"] is True and d["count"] == 1 and d["imported_at"]
    assert cliente.get("/api/youtube/cookies").json()["configured"] is True

    assert cliente.delete("/api/youtube/cookies").status_code == 204
    assert cliente.get("/api/youtube/cookies").json()["configured"] is False


def test_post_con_cuerpo_de_texto_crudo(tmp_path, monkeypatch, cliente):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    r = cliente.post("/api/youtube/cookies", content=_cookies_txt(("youtube.com",)))
    assert r.status_code == 200
    assert r.json()["count"] == 1


def test_post_sin_youtube_da_422(tmp_path, monkeypatch, cliente):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    r = cliente.post("/api/youtube/cookies",
                     files={"file": ("cookies.txt", _cookies_txt(("example.org",)),
                                     "text/plain")})
    assert r.status_code == 422
    assert "YouTube" in str(r.json()["detail"])


def test_post_demasiado_grande_da_422(tmp_path, monkeypatch, cliente):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    r = cliente.post("/api/youtube/cookies",
                     files={"file": ("cookies.txt", b"x" * (yc.MAX_BYTES + 1),
                                     "text/plain")})
    assert r.status_code == 422


def test_post_sin_archivo_da_422(tmp_path, monkeypatch, cliente):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    assert cliente.post("/api/youtube/cookies", content=b"").status_code == 422


# -------------------------------------------------- reintento del muro/bot
_BOT_MSG = ("ERROR: [youtube] kXYiU_JCYtU: Sign in to confirm you're not a bot. "
            "Use --cookies-from-browser or --cookies for the authentication.")


class DownloadError(Exception):
    """Mismo nombre que la de yt-dlp: el clasificador solo mira el mensaje."""


class YtDlpFalso:
    """`YoutubeDL` doble: consume un guion y despues "descarga".

    Registra los opts de cada llamada y, si la llamada trae `cookiefile`,
    guarda su contenido/ruta para poder comprobar que existia y que se borro.
    """

    guion: list = []
    opts_vistas: list[dict] = []
    cookiefile_visto: dict = {}
    job_id: str | None = None

    def __init__(self, opts):
        self.opts = opts
        type(self).opts_vistas.append(opts)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=True):
        tipo = type(self)
        cf = self.opts.get("cookiefile")
        if cf:
            p = Path(cf)
            tipo.cookiefile_visto = {
                "path": p,
                "existe": p.exists(),
                "texto": p.read_text(encoding="utf-8") if p.exists() else None,
                "modo": (p.stat().st_mode & 0o777) if p.exists() else None,
            }
        if tipo.guion:
            paso = tipo.guion.pop(0)
            if paso is not None:
                raise paso
        opts = self.opts
        rel = opts["outtmpl"].replace("%(ext)s", "mp3")
        destino = Path((opts.get("paths") or {})["home"]) / rel
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_bytes(b"\x00" * 256)
        return {"filepath": str(destino), "title": "Tema",
                "uploader": "Artista", "duration": 3}


@pytest.fixture
def yt_dlp_falso(monkeypatch):
    from backend.app import ytdlp_source as ys

    mod = types.ModuleType("yt_dlp")
    mod.YoutubeDL = YtDlpFalso
    monkeypatch.setitem(sys.modules, "yt_dlp", mod)
    monkeypatch.setattr(ys, "RETRY_DELAYS_S", (0.0, 0.0))
    monkeypatch.delenv("SPITIFO_QJS", raising=False)
    YtDlpFalso.guion = []
    YtDlpFalso.opts_vistas = []
    YtDlpFalso.cookiefile_visto = {}
    YtDlpFalso.job_id = None
    ys._LOCKS_POR_RUTA.clear()
    yield YtDlpFalso
    ys._LOCKS_POR_RUTA.clear()


def _bajar(titulo: str = "Bot") -> dict:
    from backend.app.models import Track
    from backend.app.ytdlp_source import YtDlpSource, new_job

    track = Track(source="ytdlp", source_id="yt-b", title=titulo, artist="Artista",
                  extra={"webpage_url": "https://youtu.be/abc"})
    job_id = new_job(titulo)
    YtDlpFalso.job_id = job_id
    return asyncio.run(YtDlpSource().download(track, "mp3", job_id=job_id))


def test_reintenta_una_vez_con_cookies_y_borra_el_temporal(tmp_path, monkeypatch,
                                                           storage_temporal,
                                                           yt_dlp_falso):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    yc.import_bytes(_cookies_txt(("youtube.com",)))
    st = storage_temporal(tmp_path / "lib")
    yt_dlp_falso.guion = [DownloadError(_BOT_MSG)]

    res = _bajar("Con cookies")

    # dos llamadas: la primera sin cookiefile, la segunda con la copia plana
    assert len(yt_dlp_falso.opts_vistas) == 2
    assert "cookiefile" not in yt_dlp_falso.opts_vistas[0]
    assert yt_dlp_falso.opts_vistas[1]["cookiefile"]
    # los params de resiliencia tambien viajan al download
    assert (yt_dlp_falso.opts_vistas[0]["extractor_args"]["youtube"]["player_client"]
            == ["default", "android_vr", "web_embedded"])

    visto = yt_dlp_falso.cookiefile_visto
    assert visto["existe"] is True
    assert "__Secure-1PSID" in visto["texto"]
    if sys.platform != "win32":
        assert visto["modo"] == 0o600

    # la copia plana se borro al terminar
    assert not Path(visto["path"]).exists()
    assert yt_dlp_falso.job_id is not None

    from backend.app.ytdlp_source import get_job
    assert get_job(yt_dlp_falso.job_id)["status"] == "done"
    assert st.stat(res["key"]).size > 0


def test_sin_cookies_falla_con_codigo_y_no_reintenta(tmp_path, monkeypatch,
                                                     yt_dlp_falso):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "vacio"))
    yt_dlp_falso.guion = [DownloadError(_BOT_MSG)]

    from backend.app.ytdlp_source import BotCheckError, get_job

    with pytest.raises(BotCheckError):
        _bajar("Sin cookies")

    assert len(yt_dlp_falso.opts_vistas) == 1  # ni un reintento
    job = get_job(yt_dlp_falso.job_id)
    assert job["status"] == "error"
    assert job["error_code"] == "youtube_bot_check"


def test_un_error_no_relacionado_no_toca_las_cookies(tmp_path, monkeypatch,
                                                     yt_dlp_falso):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    yc.import_bytes(_cookies_txt(("youtube.com",)))
    yt_dlp_falso.guion = [DownloadError("ERROR: [youtube] abc: Video unavailable")]

    with pytest.raises(RuntimeError):
        _bajar("Permanente")

    assert len(yt_dlp_falso.opts_vistas) == 1
    assert yt_dlp_falso.cookiefile_visto == {}


def test_si_el_reintento_con_cookies_tambien_falla_queda_el_codigo(tmp_path,
                                                                  monkeypatch,
                                                                  yt_dlp_falso):
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path / "data"))
    yc.import_bytes(_cookies_txt(("youtube.com",)))
    yt_dlp_falso.guion = [DownloadError(_BOT_MSG), DownloadError(_BOT_MSG)]

    from backend.app.ytdlp_source import get_job

    with pytest.raises(RuntimeError):
        _bajar("Bot de nuevo")

    assert len(yt_dlp_falso.opts_vistas) == 2
    assert not Path(yt_dlp_falso.cookiefile_visto["path"]).exists()
    job = get_job(yt_dlp_falso.job_id)
    assert job["status"] == "error"
    assert job["error_code"] == "youtube_bot_check"


# ------------------------------------------------------------- en disco
@pytest.mark.skipif(sys.platform == "win32", reason="0600 es de POSIX")
def test_permisos_0600_fuera_de_windows(tmp_path):
    store = yc.CookieStore(tmp_path / "c.bin", tokens_mod.PlainProtector())
    store.import_bytes(_cookies_txt(("youtube.com",)))
    assert (tmp_path / "c.bin").stat().st_mode & 0o777 == 0o600


@pytest.mark.skipif(sys.platform != "win32", reason="DPAPI es de Windows")
def test_dpapi_round_trip_y_no_deja_las_cookies_en_claro(tmp_path):
    store = yc.CookieStore(tmp_path / "c.bin", tokens_mod.DpapiProtector())
    info = store.import_bytes(_cookies_txt(("youtube.com",)))
    assert info["configured"] is True
    assert "__Secure-1PSID" in store.text()
    en_disco = (tmp_path / "c.bin").read_bytes()
    assert b"__Secure-1PSID" not in en_disco
    assert b"SECRETO-youtube.com" not in en_disco


def test_status_sin_archivo(tmp_path):
    store = yc.CookieStore(tmp_path / "c.bin", tokens_mod.PlainProtector())
    assert store.status() == {"configured": False, "imported_at": None, "count": 0}
    assert store.text() is None
    store.remove()  # no falla si no esta
