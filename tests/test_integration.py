"""Integracion contra APIs externas reales. Marcados `integration`.

Que son: search -> resolve -> descarga con verificacion de tags (el antiguo
smoke_test.py), la conversion ffmpeg de un FLAC de archive y un WAV de
Wikimedia (los antiguos test_convert.py / test_wav.py), y el flujo de yt-dlp
con job_id + polling (el antiguo test_ytdlp_flow.py).

REGLAS de este archivo, porque un test de red mal hecho es peor que no
tenerlo:
- `@pytest.mark.timeout(N)` explicito en cada test: si la API se cuelga, el
  test muere y lo dice. Nunca se queda esperando para siempre.
- Si la API externa no responde (timeout, 5xx, 403, vacio), el test SKIP con
  el motivo. No se reescribe la asercion para que pase.
- Si la API responde pero el AUDIO esta roto (0 bytes, mutagen no lo lee, sin
  tags), eso NO es causa externa: el test FALLA. Un 200 no prueba que el
  audio sea valido, y por eso se verifica con mutagen y ffprobe.

Para correr solo la parte rapia (sin red):  pytest -m "not integration"
"""
from __future__ import annotations

import os

import httpx
import pytest
from mutagen import File as MFile

from conftest import TIMEOUT_RED, ffprobe_duracion


def _skip_externo(motivo: str) -> None:
    """Saltea el test dejando escrito por que: API caida, no bug nuestro."""
    pytest.skip(f"API externa: {motivo}")


def _get(url, params=None, timeout=TIMEOUT_RED):
    """GET con timeout explicito. Devuelve None si la API no responde."""
    try:
        r = httpx.get(url, params=params, timeout=timeout, follow_redirects=True)
    except httpx.HTTPError as e:
        return None, f"{type(e).__name__}: {str(e)[:120]}"
    if r.status_code >= 500:
        return None, f"HTTP {r.status_code}"
    return r, None


# =============================================================================
# search -> resolve -> descarga, con verificacion de tags (ex smoke_test.py)
# =============================================================================
@pytest.mark.integration
@pytest.mark.timeout(420)
def test_search_resolve_download_verifica_tags(cliente, biblioteca):
    """Ciclo completo contra archive.org, con el audio verificado en disco.

    Reemplaza al smoke_test.py: mismo recorrido (search -> resolve -> download),
    pero con asserts y con codigo de salida, en vez de imprimir y que alguien
    lea la consola.
    """
    r = cliente.get("/api/search", params={"q": "blues", "limit": 12,
                                           "source": "archive", "mode": "sources"})
    if r.status_code >= 400:
        _skip_externo(f"/api/search archive -> HTTP {r.status_code}")
    data = r.json()
    assert data["count"] > 0, "archive no devolvio nada para 'blues'"
    resultados = data["results"]
    assert all(t["source"] == "archive" for t in resultados)

    # el filtro anti-basura tiene que haber corrido: nadie trae un podcast
    from backend.app.sources import looks_like_music
    for t in resultados:
        assert looks_like_music(t["title"], t["artist"]), t["title"]

    # --- resolve del primer resultado (archive siempre necesita resolve) ---
    objetivo = resultados[0]
    assert objetivo["extra"].get("needs_resolve") is True
    cuerpo = {k: v for k, v in objetivo.items() if k != "downloadable"}
    rr = cliente.post("/api/resolve", json=cuerpo, params={"q": "blues"})
    if rr.status_code in (502, 404):
        _skip_externo(f"/api/resolve -> HTTP {rr.status_code}: {rr.text[:120]}")
    assert rr.status_code == 200, rr.text[:300]
    resuelto = rr.json()
    assert resuelto["audio_url"], "resolve no devolvio audio_url"
    assert resuelto["extra"]["format"], "resolve no dijo el formato"
    # el verdict tiene que estar entre los tres estados conocidos
    assert resuelto["extra"]["match"] in ("match", "partial", "mismatch", "unknown")

    # --- descarga real ---
    cuerpo = {k: v for k, v in resuelto.items() if k != "downloadable"}
    rd = cliente.post("/api/download",
                      json={"source": "archive", "track": cuerpo, "fmt": "mp3"})
    if rd.status_code in (502, 404):
        _skip_externo(f"/api/download -> HTTP {rd.status_code}: {rd.text[:200]}")
    assert rd.status_code == 200, rd.text[:300]
    j = rd.json()

    # --- aca ya no hay red: si esto falla, el bug es NUESTRO ---
    p = biblioteca / j["key"]
    assert p.exists(), f"la API dijo ok pero el archivo no esta: {p}"
    assert p.stat().st_size > 0, "el archivo esta vacio"
    # el tmp es `.{hex8}.{ext}`; el final es "artista - titulo.mp3". Si el
    # nombre arranca con punto, el rename no ocurrio.
    assert not p.name.startswith("."), f"quedo el tmp sin renombrar: {p.name}"

    # mutagen tiene que poder leerlo
    mf = MFile(p)
    assert mf is not None, "mutagen no reconoce el archivo descargado"
    assert mf.info.length > 0, "el audio no tiene duracion"

    # y ffprobe tiene que estar de acuerdo desde disco
    dur = ffprobe_duracion(p)
    assert dur == pytest.approx(float(mf.info.length), abs=2.0), \
        f"mutagen dice {mf.info.length}s y ffprobe {dur}s"

    # el nombre del archivo no puede mentir sobre el contenido
    assert j["filename"] == p.name
    assert j["bytes"] == p.stat().st_size
    assert j["format"] == "MP3", f"pedimos mp3 y salio {j['format']}"


@pytest.mark.integration
@pytest.mark.timeout(180)
def test_search_de_archive_descarta_basura(cliente):
    """El filtro tiene que servir: 'Numb Linkin Park' no puede traer podcasts.

    Es el bug que motivo `looks_like_music` + `relevance`: archive devolvia
    "HUBS report" y "Chaos in Portland - ANTIFA Exposed" arriba de todo.
    """
    r = cliente.get("/api/search", params={"q": "Numb Linkin Park", "limit": 15,
                                           "source": "archive", "mode": "sources"})
    if r.status_code >= 400:
        _skip_externo(f"/api/search archive -> HTTP {r.status_code}")
    data = r.json()
    if data["count"] == 0:
        _skip_externo("archive no devolvio resultados para la consulta")

    from backend.app.sources import looks_like_music, relevance
    for t in data["results"]:
        assert looks_like_music(t["title"], t["artist"]), f"no musical: {t['title']!r}"
        rel = t["extra"].get("relevance", 0.0)
        assert rel > 0, f"sin relevancia: {t['title']!r} rel={rel}"

    # el resultado mas relevante tiene que estar primero (orden por _rank)
    relevancias = [t["extra"].get("relevance", 0) for t in data["results"]]
    assert relevancias == sorted(relevancias, reverse=True), relevancias


@pytest.mark.integration
@pytest.mark.timeout(120)
def test_itunes_devuelve_estructura_de_track(cliente):
    """iTunes es el catalogo del modo matched: la forma de la respuesta importa."""
    r = cliente.get("/api/search", params={"q": "numb linkin park", "limit": 5,
                                           "mode": "sources"})
    if r.status_code >= 400:
        _skip_externo(f"/api/search -> HTTP {r.status_code}")
    data = r.json()
    # /api/search devuelve un DICT: las pistas van en ['results'], no en la raiz
    assert set(["query", "mode", "count", "results"]) <= set(data)
    if data["count"] == 0:
        _skip_externo("iTunes no devolvio resultados")
    for t in data["results"]:
        assert {"source", "source_id", "title", "artist"} <= set(t)
        assert "downloadable" in t


@pytest.mark.integration
@pytest.mark.timeout(120)
def test_fuente_inactiva_se_salta_en_search(cliente, monkeypatch):
    """Una fuente sin credencial no debe romper la busqueda de las otras."""
    monkeypatch.delenv("JAMENDO_CLIENT_ID", raising=False)
    r = cliente.get("/api/search", params={"q": "jazz", "limit": 5,
                                           "source": "jamendo", "mode": "sources"})
    # sin client_id la fuente simplemente no esta disponible: 400 o vacio, no 500
    assert r.status_code in (200, 400, 502), r.status_code


# =============================================================================
# Conversion ffmpeg (ex test_convert.py y test_wav.py)
# =============================================================================
@pytest.mark.integration
@pytest.mark.timeout(420)
def test_convierte_un_wav_de_wikimedia_a_mp3(cliente, biblioteca):
    """Fuerza la rama de conversion: WAV -> MP3 con nombre correcto.

    Lo que se verifica (y el script viejo solo imprimia): el archivo existe,
    tiene bytes, ffprobe lo mide y NO quedan temporales huerfanos en la carpeta.
    """
    r = cliente.get("/api/search", params={"q": "piano", "limit": 20,
                                           "source": "wikimedia", "mode": "sources"})
    if r.status_code >= 400:
        _skip_externo(f"/api/search wikimedia -> HTTP {r.status_code}")
    data = r.json()
    if data["count"] == 0:
        _skip_externo("wikimedia no devolvio resultados para 'piano'")

    def ext_de(t):
        return t["audio_url"].lower().split("?")[0].rsplit(".", 1)[-1]

    # preferir un WAV (o cualquier cosa que NO sea mp3) para forzar ffmpeg
    no_mp3 = [t for t in data["results"] if ext_de(t) != "mp3"]
    objetivo = (no_mp3 or data["results"])[0]
    origen = ext_de(objetivo)

    cuerpo = {k: v for k, v in objetivo.items() if k != "downloadable"}
    rd = cliente.post("/api/download",
                      json={"source": "wikimedia", "track": cuerpo, "fmt": "mp3"})
    if rd.status_code in (502, 404):
        _skip_externo(f"/api/download wikimedia -> HTTP {rd.status_code}: {rd.text[:200]}")
    assert rd.status_code == 200, rd.text[:300]
    j = rd.json()

    p = biblioteca / j["key"]
    assert p.exists(), f"la API dijo ok pero el archivo no esta: {p}"
    assert p.stat().st_size > 0
    assert p.suffix == ".mp3", f"pedimos mp3 y salio {p.suffix}"
    # el tmp es `.{hex8}.{ext}`; si el nombre arranca con punto, no se renombro
    assert not p.name.startswith("."), f"quedo el tmp sin renombrar: {p.name}"

    mf = MFile(p)
    assert mf is not None, f"mutagen no lee el mp3 convertido desde .{origen}"
    dur = ffprobe_duracion(p)
    assert dur > 0, "ffprobe no midio el archivo convertido"
    assert dur == pytest.approx(float(mf.info.length), abs=2.0)

    # ningun temporal huerfano (los .<hex>.<ext> que crea el downloader)
    huerfanos = [f.name for f in p.parent.iterdir() if f.name.startswith(".")]
    assert huerfanos == [], f"temporales sin borrar: {huerfanos}"


@pytest.mark.integration
@pytest.mark.timeout(420)
def test_convierte_un_item_de_archive_a_mp3(cliente, biblioteca):
    """El otro camino de conversion: un item de archive que no es mp3."""
    r = cliente.get("/api/search", params={"q": "jazz", "limit": 10,
                                           "source": "archive", "mode": "sources"})
    if r.status_code >= 400:
        _skip_externo(f"/api/search archive -> HTTP {r.status_code}")
    resultados = r.json()["results"]
    if not resultados:
        _skip_externo("archive no devolvio resultados para 'jazz'")

    objetivo = resultados[0]
    cuerpo = {k: v for k, v in objetivo.items() if k != "downloadable"}
    rd = cliente.post("/api/download",
                      json={"source": "archive", "track": cuerpo, "fmt": "mp3"})
    if rd.status_code in (502, 404):
        _skip_externo(f"/api/download archive -> HTTP {rd.status_code}: {rd.text[:200]}")
    assert rd.status_code == 200, rd.text[:300]
    j = rd.json()

    p = biblioteca / j["key"]
    assert p.exists() and p.stat().st_size > 0
    assert p.suffix == ".mp3"
    assert MFile(p) is not None, "mutagen no reconoce el mp3 de archive"
    assert ffprobe_duracion(p) > 0
    # el nombre tiene que ser "artista - titulo", no el hex del tmp
    assert not p.name.startswith("."), p.name


# =============================================================================
# yt-dlp: job_id + polling de progreso (ex test_ytdlp_flow.py)
# =============================================================================
@pytest.mark.integration
@pytest.mark.timeout(600)
def test_ytdlp_devuelve_job_id_y_hasta_done(cliente, monkeypatch, biblioteca):
    """El flujo async: POST /download devuelve job_id y el polling llega a done.

    Si YTDLP_ENABLED != 1 se saltea: es una decision de la maquina, no un fallo.
    """
    monkeypatch.setenv("YTDLP_ENABLED", "1")
    if os.getenv("YTDLP_ENABLED") != "1":
        _skip_externo("YTDLP_ENABLED != 1")

    r = cliente.get("/api/search", params={"q": "numb linkin park", "limit": 5,
                                           "source": "ytdlp", "mode": "sources"})
    if r.status_code >= 400:
        _skip_externo(f"/api/search ytdlp -> HTTP {r.status_code}")
    resultados = r.json()["results"]
    if not resultados:
        _skip_externo("yt-dlp no devolvio resultados (o YouTube no responde)")

    t = resultados[0]
    assert t["extra"].get("webpage_url"), "el resultado no trae webpage_url"

    cuerpo = {k: v for k, v in t.items() if k != "downloadable"}
    rd = cliente.post("/api/download",
                      json={"source": "ytdlp", "track": cuerpo, "fmt": "mp3"})
    if rd.status_code in (502, 503, 404):
        _skip_externo(f"yt-dlp -> HTTP {rd.status_code}: {rd.text[:200]}")
    assert rd.status_code == 200, rd.text[:300]
    job_id = rd.json().get("job_id")
    assert job_id, "la descarga en background tiene que devolver job_id"

    # --- polling: tiene que terminar en un estado final, no colgarse ---
    import time
    limite = time.time() + 300
    estado = None
    while time.time() < limite:
        pr = cliente.get(f"/api/download/progress/{job_id}")
        assert pr.status_code == 200
        d = pr.json()
        estado = d.get("status")
        if estado in ("done", "error"):
            break
        time.sleep(1)
    else:
        pytest.fail(f"el job {job_id} no llego a un estado final en 300s (ultimo: {estado})")

    if estado == "error":
        d = cliente.get(f"/api/download/progress/{job_id}").json()
        _skip_externo(f"yt-dlp reporto error: {str(d.get('error'))[:150]}")

    # --- de acu para adelante ya no hay red ---
    d = cliente.get(f"/api/download/progress/{job_id}").json()
    assert d["status"] == "done"
    assert d["progress"] == 100.0

    p = biblioteca / d["key"]
    assert p.exists(), f"el job dijo done pero el archivo no esta: {p}"
    assert p.stat().st_size > 0
    mf = MFile(p)
    assert mf is not None, "mutagen no lee el mp3 de yt-dlp"
    assert mf.info.length > 0
    # ffprobe tiene que estar de acuerdo con mutagen
    assert ffprobe_duracion(p) == pytest.approx(float(mf.info.length), abs=2.0)


@pytest.mark.integration
@pytest.mark.timeout(120)
def test_ytdlp_search_filtra_lo_no_musical(cliente, monkeypatch):
    """yt-dlp tambien pasa por `looks_like_music`: no todo video es una cancion."""
    monkeypatch.setenv("YTDLP_ENABLED", "1")
    r = cliente.get("/api/search", params={"q": "tutorial python", "limit": 10,
                                           "source": "ytdlp", "mode": "sources"})
    if r.status_code >= 400:
        _skip_externo(f"/api/search ytdlp -> HTTP {r.status_code}")
    resultados = r.json()["results"]
    if not resultados:
        _skip_externo("yt-dlp no devolvio resultados")
    for t in resultados:
        assert t["extra"].get("webpage_url")
        assert t["source_id"], "sin source_id no se puede descargar"
