"""El matcher: la logica mas delicada de Spitifo, testeada sin red.

Reglas (de `matcher.py`):
- el CANAL del video tiene que contener el nombre del artista, O
- el titulo tiene que coincidir Y la duracion estar dentro de 12s
- sin ninguna de las dos: NO matchear (mejor "sin version" que la cancion
  equivocada)
- duracion con mas de 90s de diferencia: rechazo
- un video NO se reutiliza para dos pistas distintas

Todo esto corre contra una fuente YouTube **falsa** (ver conftest), asi que la
suite es offline y determinista. La regresion de Bohemian Rhapsody (3 pistas con
el mismo titulo -> 3 videos distintos) es el caso que mas valor aporta
justamente por esto: verifica la desambiguacion sin depender de YouTube.

No hay pytest-asyncio en el venv: los tests son sync y usan `asyncio.run` para
no agregar dependencias.
"""
from __future__ import annotations

import asyncio

import pytest

from backend.app.matcher import (
    DUR_REJECT,
    DUR_TOL,
    MIN_SCORE,
    channel_matches,
    enrich_with_ytdlp,
    score_pair,
)


# ------------------------------------------------------------ channel_matches
@pytest.mark.parametrize("artista,canal,esperado", [
    ("Linkin Park", "Linkin Park", True),
    ("Linkin Park", "LinkinParkOfficialVEVO", True),
    ("Queen", "queenofficial", True),
    ("Panic! At the Disco", "PanicSoundsVEVO", True),
    ("Pentatonix", "Pentatonix", True),
    # el canal NO contiene al artista -> sin senal fuerte
    ("Queen", "SomeRandomChannel", False),
    ("Linkin Park", "Park Rascals", False),
    # entradas vacias: no hay nada que comparar
    ("", "Queen", False),
    ("Queen", "", False),
])
def test_channel_matches_tabla(artista, canal, esperado):
    """Compara la PRIMERA palabra del artista contra el canal normalizado."""
    assert channel_matches(artista, canal) is esperado


# ----------------------------------------------------------------- score_pair
def test_constantes_de_match():
    """Las constantes son el contrato del filtro; que no se muevan en silencio."""
    assert (MIN_SCORE, DUR_TOL, DUR_REJECT) == (0.75, 12.0, 90.0)


@pytest.mark.parametrize("delta,esperado", [
    # duracion dentro de la ventana -> suma el bonus de duracion
    (0, (1.0, "canal+dur")),
    (5, (1.0, "canal+dur")),
    (12, (1.0, "canal+dur")),   # el borde exacto todavia entra
    # fuera de la ventana, pero el canal salva el match
    (13, (1.0, "canal")),
    (17, (1.0, "canal")),
    (77, (1.0, "canal")),
    (89, (1.0, "canal")),
    # >90s = live vs studio / remix: rechazo duro aunque coincida el canal
    (91, (0.0, "duración muy distinta")),
    (200, (0.0, "duración muy distinta")),
])
def test_score_pair_por_delta_de_duracion(delta, esperado):
    """delta = diferencia de duracion entre iTunes y el video (base 223s)."""
    score, por_que = score_pair("Numb", "Linkin Park", 223,
                                "Numb", "Linkin Park", 223 + delta)
    assert (score, por_que) == esperado


def test_score_pair_borde_de_90_acepta_90_exacto():
    """90s exactos NO es rechazo: el corte es `> 90`, no `>= 90`."""
    assert score_pair("Numb", "Linkin Park", 223, "Numb", "Linkin Park", 313) \
        == (1.0, "canal")
    assert score_pair("Numb", "Linkin Park", 223, "Numb", "Linkin Park", 314) \
        == (0.0, "duración muy distinta")


def test_score_pair_titulo_y_duracion_sin_canal_alcanza_el_minimo():
    """Sin canal, titulo identico + duracion buena = match (senal alternativa)."""
    score, por_que = score_pair("Numb", "Linkin Park", 223, "Numb", "Canal Raro", 224)
    assert (score, por_que) == (1.0, "+dur")
    assert score >= MIN_SCORE


@pytest.mark.parametrize("args,esperado", [
    # sin canal y sin duracion buena: NO matchea aunque el titulo sea identico
    (("Numb", "Linkin Park", 223, "Numb", "Canal Raro", 300), (0.0, "sin-señal")),
    # sin canal y con titulo distinto: menos que eso, tampoco
    (("Numb", "Linkin Park", 223, "In The End", "Canal Raro", 224), (0.0, "sin-señal")),
])
def test_score_pair_sin_señal_no_matchea(args, esperado):
    """Preferimos decir "sin version descargable" antes que bajar la cancion mal."""
    assert score_pair(*args) == esperado


def test_score_pair_titulo_distinto_baja_del_minimo():
    """Aunque el canal coincida, si el titulo no se parece no alcanza MIN_SCORE."""
    score, _ = score_pair("Numb", "Linkin Park", 223, "In The End", "Linkin Park", 224)
    assert score < MIN_SCORE


def test_score_pair_sin_duracion_sigue_creyendo_en_el_canal():
    """Sin duracion de iTunes la ventana no aplica, pero el canal sigue valiendo."""
    assert score_pair("Numb", "Linkin Park", 0, "Numb", "Linkin Park", 0) \
        == (1.0, "canal")


# ------------------------------------------------- enrich_with_ytdlp (offline)
def _video(id_, titulo, canal, duracion):
    return {"id": id_, "title": titulo, "uploader": canal, "duration": duracion}


# 3 pistas DISTINTAS que comparten el titulo "Bohemian Rhapsody".
ITUNES = [
    {"trackId": 1001, "trackName": "Bohemian Rhapsody", "artistName": "Queen",
     "trackTimeMillis": 355_000},
    {"trackId": 1002, "trackName": "Bohemian Rhapsody",
     "artistName": "Panic! At the Disco", "trackTimeMillis": 380_000},
    {"trackId": 1003, "trackName": "Bohemian Rhapsody", "artistName": "Pentatonix",
     "trackTimeMillis": 355_000},
]
VIDEOS = [
    _video("q1", "Queen - Bohemian Rhapsody (Official Video)", "QueenOfficial", 355),
    _video("p2", "Bohemian Rhapsody (Panic! At the Disco cover)", "PanicSoundsVEVO", 380),
    _video("x3", "Bohemian Rhapsody - Pentatonix", "Pentatonix", 356),
]


def test_bohemian_rhapsody_tres_pistas_tres_videos(fake_ytdlp):
    """REGRESION: 3 pistas del mismo titulo -> 3 videos DISTINTOS.

    Con matching ingenuo ("el video cuyo titulo se parece mas") las tres
    acababan en el video de Queen. Este test sostiene la regla "un video no se
    reutiliza para dos pistas". Corre offline con una fuente falsa.
    """
    src = fake_ytdlp(VIDEOS)
    match = asyncio.run(enrich_with_ytdlp(ITUNES, "Bohemian Rhapsody", src))

    # cada pista recibio SU video, el correcto segun su artista
    assert match["1001"]["video"]["id"] == "q1"   # Queen
    assert match["1002"]["video"]["id"] == "p2"   # Panic! At the Disco
    assert match["1003"]["video"]["id"] == "x3"   # Pentatonix

    # ningun video se reutilizo entre pistas
    usados = [v["video"]["id"] for v in match.values() if v["video"]]
    assert len(usados) == len(set(usados)) == 3
    assert set(usados) == {"q1", "p2", "x3"}


def test_bohemian_rhapsody_todas_con_match_confiable(fake_ytdlp):
    """Las 3 matchean por canal+duracion, todas por encima del minimo."""
    src = fake_ytdlp(VIDEOS)
    match = asyncio.run(enrich_with_ytdlp(ITUNES, "Bohemian Rhapsody", src))
    for key, entrada in match.items():
        assert entrada["video"] is not None, key
        assert entrada["score"] >= MIN_SCORE, (key, entrada)
        assert entrada["why"] == "canal+dur"


def test_enrich_arma_la_url_del_video(fake_ytdlp):
    """Cada match trae la webpage_url que usa la UI para descargar."""
    src = fake_ytdlp(VIDEOS)
    match = asyncio.run(enrich_with_ytdlp(ITUNES, "Bohemian Rhapsody", src))
    assert match["1001"]["webpage_url"] == "https://www.youtube.com/watch?v=q1"


def test_enrich_sin_video_confiable_no_inventa_match(fake_ytdlp):
    """Un solo video, de otro canal y con duracion absurda: NADIA matchea."""
    ruido = [_video("z9", "Bohemian Rhapsody en vivo 1975", "Concierto Random", 2000)]
    match = asyncio.run(enrich_with_ytdlp(ITUNES, "Bohemian Rhapsody", fake_ytdlp(ruido)))
    for entrada in match.values():
        assert entrada["video"] is None
        assert entrada["score"] == 0.0


def test_enrich_busca_una_sola_vez(fake_ytdlp):
    """No se puede llamar a YouTube una vez por pista: una busqueda, N tracks."""
    src = fake_ytdlp(VIDEOS)
    asyncio.run(enrich_with_ytdlp(ITUNES, "Bohemian Rhapsody", src))
    assert src.llamadas == 1


def test_enrich_si_yt_dlp_falla_devuelve_vacio(fake_ytdlp):
    """Si la busqueda de YouTube revienta, el matcher se apaga sin tumbar /api/search."""
    class Roto:
        def available(self):
            return True

        async def search_candidates(self, q, limit=40):
            raise RuntimeError("yt-dlp: la API no respondio")

    assert asyncio.run(enrich_with_ytdlp(ITUNES, "x", Roto())) == {}


def test_enrich_sin_fuente_devuelve_vacio():
    """Sin fuente de YouTube (yt-dlp apagado) no hay nada que emparejar."""
    assert asyncio.run(enrich_with_ytdlp(ITUNES, "x", None)) == {}


def test_enrich_sin_tracks_devuelve_vacio(fake_ytdlp):
    assert asyncio.run(enrich_with_ytdlp([], "x", fake_ytdlp(VIDEOS))) == {}


def test_enrich_fuente_despagada_no_busca(fake_ytdlp):
    """available() False = yt-dlp apagado: ni se intenta la busqueda."""
    src = fake_ytdlp(VIDEOS, disponible=False)
    assert asyncio.run(enrich_with_ytdlp(ITUNES, "x", src)) == {}
    assert src.llamadas == 0
