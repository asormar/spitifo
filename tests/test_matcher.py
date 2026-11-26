"""El matcher: la logica mas delicada de Spitifo, testeada sin red.

Reglas (de `matcher.py`):
- el video tiene que nombrar al ARTISTA de la ficha (canal o titulo)
- el titulo de la ficha tiene que estar entero en el del video
- otra version (en directo, cover, remix...) que la ficha no pide: rechazo
- duracion con mas de 90s de diferencia: rechazo; dentro de 12s suma
- un video NO se reutiliza, y el reparto es global (por puntaje)

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
    TITLE_MIN,
    artist_in,
    channel_matches,
    credited_artists,
    enrich_with_ytdlp,
    score_pair,
)


# ------------------------------------------------------------ channel_matches
@pytest.mark.parametrize("artista,canal,esperado", [
    ("Linkin Park", "Linkin Park", True),
    ("Linkin Park", "LinkinParkOfficialVEVO", True),
    ("Queen", "queenofficial", True),
    ("Panic! At the Disco", "PanicAtTheDiscoVEVO", True),
    # "The Beatles" no puede quedarse en "the": cualquier canal lo tiene
    ("The Beatles", "The Other Channel", False),
    ("The Beatles", "TheBeatlesVEVO", True),
    ("Rosalía", "ROSALÍA", True),
    ("Pentatonix", "Pentatonix", True),
    # el canal NO contiene al artista -> sin senal fuerte
    ("Queen", "SomeRandomChannel", False),
    ("Linkin Park", "Park Rascals", False),
    # entradas vacias: no hay nada que comparar
    ("", "Queen", False),
    ("Queen", "", False),
])
def test_channel_matches_tabla(artista, canal, esperado):
    """El canal nombra al artista (sin espacios ni tildes, sin "the")."""
    assert channel_matches(artista, canal) is esperado


# ----------------------------------------------------------------- score_pair
def test_constantes_de_match():
    """Las constantes son el contrato del filtro; que no se muevan en silencio."""
    assert (MIN_SCORE, DUR_TOL, DUR_REJECT, TITLE_MIN) == (0.75, 12.0, 90.0, 0.8)


@pytest.mark.parametrize("delta,esperado", [
    # duracion dentro de la ventana -> suma el bonus de duracion
    (0, (1.0, "canal+dur")),
    (12, (1.0, "canal+dur")),   # el borde exacto todavia entra
    # fuera de la ventana: el canal del artista alcanza, con menos puntaje
    (13, (0.8, "canal")),
    (90, (0.8, "canal")),       # 90 exactos NO es rechazo: el corte es `> 90`
    # >90s = live vs studio / remix: rechazo duro aunque coincida el canal
    (91, (0.0, "duración muy distinta")),
    (200, (0.0, "duración muy distinta")),
])
def test_score_pair_por_delta_de_duracion(delta, esperado):
    """delta = diferencia de duracion entre iTunes y el video (base 223s)."""
    assert score_pair("Numb", "Linkin Park", 223,
                      "Numb", "Linkin Park", 223 + delta) == esperado


def test_score_pair_sin_duracion_sigue_creyendo_en_el_canal():
    assert score_pair("Numb", "Linkin Park", 0, "Numb", "Linkin Park", 0) == (0.8, "canal")


def test_artista_en_el_titulo_vale_aunque_el_canal_sea_otro():
    """Un canal de letras que nombra al artista en el titulo: vale, con menos
    puntaje que el canal oficial."""
    s, por_que = score_pair("Numb", "Linkin Park", 223,
                            "Linkin Park - Numb (Official Audio)", "Canal Raro", 224)
    assert por_que == "titulo+dur"
    assert MIN_SCORE <= s < 1.0


@pytest.mark.parametrize("ficha,artista,video,canal,motivo", [
    # REGRESION (estudio de usuarios): "Creep" de TLC se quedaba con un directo
    # de Radiohead porque titulo y duracion se parecian. Sin artista: rechazo.
    ("Creep", "TLC", 'Radiohead Perform "Creep" Live on September 14, 1995',
     "Conan O'Brien", "sin-artista"),
    # REGRESION: "Rosalía" de Juan Luis Guerra se bajaba "La Perla" de ROSALÍA.
    ("Rosalía", "Juan Luis Guerra 4.40", "ROSALÍA - La Perla (Official Video)",
     "ROSALÍA", "sin-artista"),
    # REGRESION: "LA FAMA" se quedaba con "La Yugular" por compartir "la".
    ("LA FAMA", "ROSALÍA & The Weeknd", "ROSALÍA - La Yugular (Official Lyric Video)",
     "ROSALÍA", "otro-titulo"),
    # el artista correcto, pero otra version que la ficha no pide
    ("Numb", "Linkin Park", "Linkin Park - Numb (Live in Red Square)",
     "Linkin Park", "otra-version"),
    ("Creep", "Radiohead", "Radiohead - Creep (Acoustic)", "Radiohead", "otra-version"),
    ("Levels", "Avicii", "Avicii - Levels (Skrillex Remix)", "Avicii", "otra-version"),
    # "The Beatles": antes bastaba con que el canal tuviera "the"
    ("Yesterday", "The Beatles", "Yesterday", "The Other Channel", "sin-artista"),
])
def test_score_pair_rechazos(ficha, artista, video, canal, motivo):
    """Preferimos decir "sin version descargable" antes que bajar la cancion mal."""
    assert score_pair(ficha, artista, 200, video, canal, 200) == (0.0, motivo)


# ------------------------------------------- creditos "feat." en el titulo
def test_feat_en_el_titulo_nombre_al_artista_en_el_video():
    """La ficha pone al cantante en 'feat.'; el video lo nombra a el."""
    s, por_que = score_pair("Refrain (feat. Kasane Teto)", "HAL@修羅場P", 200,
                            "HAL - Refrain feat. Kasane Teto", "Canal Random", 201)
    assert s >= MIN_SCORE
    assert por_que == "titulo+dur"


def test_feat_en_el_titulo_cuenta_como_match_de_canal():
    """El canal del invitado vale como canal del artista (no como titulo)."""
    s, por_que = score_pair("Refrain (feat. Kasane Teto)", "HAL@修羅場P", 200,
                            "Refrain", "Kasane Teto Official", 200)
    assert s == 1.0
    assert por_que == "canal+dur"


@pytest.mark.parametrize("titulo,canal", [
    ("Refrain [feat. Kasane Teto]", "Kasane Teto Official"),
    ("Refrain (Featuring Kasane Teto)", "Kasane Teto Official"),
    ("Refrain (with Kasane Teto)", "Kasane Teto Official"),
    ("Refrain (ft. Kasane Teto)", "Kasane Teto Official"),
    ("Refrain (feat. A & Kasane Teto)", "Kasane Teto Official"),
])
def test_feat_en_el_titulo_acepta_distintas_escrituras(titulo, canal):
    """Parentesis, corchetes y separadores de credito, todos por la misma puerta."""
    s, por_que = score_pair(titulo, "HAL@修羅場P", 200,
                            "Refrain", canal, 200)
    assert s >= MIN_SCORE
    assert por_que == "canal+dur"


def test_feat_en_el_titulo_no_abre_la_puerta_a_cualquiera():
    """Sin nadie del credito ni del feat. en el video: sin-artista."""
    assert score_pair("Refrain (feat. Kasane Teto)", "HAL@修羅場P", 200,
                      "Refrain (Official Audio)", "Canal Random", 200) == (0.0, "sin-artista")


def test_feat_en_el_titulo_no_acepta_otra_version():
    """El cover se rechaza aunque nombre al invitado acreditado."""
    assert score_pair("Refrain (feat. Kasane Teto)", "HAL@修羅場P", 200,
                      "Refrain (Cover) Kasane Teto", "Kasane Teto Official", 200) == (0.0, "otra-version")


def test_si_la_ficha_pide_la_version_el_video_vale():
    s, _ = score_pair("Numb (Live)", "Linkin Park", 200,
                      "Linkin Park - Numb (Live)", "Linkin Park", 200)
    assert s >= MIN_SCORE


def test_la_ficha_remasterizada_vale_para_el_video_normal():
    """Remaster, anio e invitados no cambian la cancion."""
    for ficha in ("Something (Remastered 2009)", "Something - 2019 Mix",
                  "Something (feat. Nadie)", "Something - Remastered 2009"):
        s, _ = score_pair(ficha, "The Beatles", 182,
                          "The Beatles - Something", "The Beatles", 182)
        assert s >= MIN_SCORE, ficha


def test_video_de_letra_vale_menos_que_el_oficial():
    oficial, _ = score_pair("Numb", "Linkin Park", 200,
                            "Linkin Park - Numb (Official Video)", "Linkin Park", 200)
    letra, por_que = score_pair("Numb", "Linkin Park", 200,
                                "Linkin Park - Numb (Lyrics)", "Linkin Park", 200)
    assert por_que.endswith("+letra")
    assert MIN_SCORE <= letra < oficial


def test_acentos_y_escrituras_no_latinas():
    s, _ = score_pair("Tití Me Preguntó", "Bad Bunny", 243,
                      "BAD BUNNY - TITI ME PREGUNTÓ (Video Oficial)", "Bad Bunny", 245)
    assert s == 1.0
    s, _ = score_pair("夜に駆ける", "YOASOBI", 261,
                      "YOASOBI「夜に駆ける」Official Music Video", "Ayase / YOASOBI", 262)
    assert s == 1.0


@pytest.mark.parametrize("artista,esperado", [
    ("ROSALÍA & Rauw Alejandro", ["rosalia", "rauw alejandro"]),
    ("Bad Bunny feat. Chencho Corleone", ["bad bunny", "chencho corleone"]),
    ("KAROL G, Shakira", ["karol g", "shakira"]),
    ("Fred again..", ["fred again"]),
])
def test_credited_artists(artista, esperado):
    assert credited_artists(artista) == esperado


def test_artista_corto_tiene_que_ser_palabra_suelta():
    assert artist_in("TLC", "TLC - Creep")
    assert not artist_in("TLC", "Stilcrafting channel")
    assert artist_in("U2", "U2 - One")
    assert not artist_in("U2", "Ku2rt music")


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
    _video("p2", "Panic! At The Disco - Bohemian Rhapsody (Audio)", "Panic! At The Disco", 380),
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


# -------------------------------------------------- offload del match grupal
def test_enrich_con_mas_de_una_pista_ofrece_el_match_a_un_hilo(monkeypatch, fake_ytdlp):
    """El cruce de puntajes (hasta 30x40 parejas) no corre en el loop."""
    import backend.app.matcher as matcher_mod

    hilos = []
    real_to_thread = asyncio.to_thread

    async def _to_thread_espia(fn, *a, **kw):
        hilos.append(fn)
        return await real_to_thread(fn, *a, **kw)

    monkeypatch.setattr(matcher_mod.asyncio, "to_thread", _to_thread_espia)
    src = fake_ytdlp(VIDEOS)
    asyncio.run(enrich_with_ytdlp(ITUNES, "Bohemian Rhapsody", src))
    assert hilos == [matcher_mod._score_pass]


def test_enrich_una_sola_pista_no_ofrece_nada_a_un_hilo(monkeypatch, fake_ytdlp):
    """Una pista suelta: pocas parejas, no vale la pena el viaje a un hilo."""
    import backend.app.matcher as matcher_mod

    hilos = []

    async def _to_thread_espia(fn, *a, **kw):
        hilos.append(fn)
        raise AssertionError("no deberia llamarse")

    monkeypatch.setattr(matcher_mod.asyncio, "to_thread", _to_thread_espia)
    src = fake_ytdlp(VIDEOS)
    asyncio.run(enrich_with_ytdlp([ITUNES[0]], "Bohemian Rhapsody", src))
    assert hilos == []


def test_enrich_el_segundo_pase_de_alias_tambien_se_ofrece_al_hilo(monkeypatch, fake_ytdlp):
    """Finding #5 (search-latency): si el match grupal se offloadea, el
    segundo pase (con los alias japoneses ya puestos) tiene que ir al MISMO
    hilo, no al loop, o la ganancia del primer pase se pierde en el segundo."""
    import backend.app.matcher as matcher_mod

    raw = {"trackId": 1, "trackName": "Mesmerizer", "artistName": "Satsuki",
          "trackTimeMillis": 200000}
    otra = {"trackId": 2, "trackName": "Otra", "artistName": "Alguien",
           "trackTimeMillis": 200000}
    videos = [
        {"id": "v1", "title": "サツキ - メズマライザー", "uploader": "サツキ", "duration": 200},
        {"id": "v2", "title": "Alguien - Otra", "uploader": "Alguien", "duration": 200},
    ]

    async def _alias(ficha):
        return ({"title": "メズマライザー", "artist": "サツキ"}
                if ficha.get("trackId") == 1 else {})

    monkeypatch.setattr(matcher_mod, "_aliases_for", _alias)

    pases_en_hilo = []
    real_to_thread = asyncio.to_thread

    async def _to_thread_espia(fn, *a, **kw):
        pases_en_hilo.append(fn)
        return await real_to_thread(fn, *a, **kw)

    monkeypatch.setattr(matcher_mod.asyncio, "to_thread", _to_thread_espia)
    res = asyncio.run(enrich_with_ytdlp(
        [raw, otra], "Mesmerizer Satsuki", fake_ytdlp(videos)))

    assert res["1"]["video"]["id"] == "v1"  # el alias encontro la pareja
    # dos pases (sin y con alias), los dos offloadeados al mismo hilo.
    assert pases_en_hilo == [matcher_mod._score_pass, matcher_mod._score_pass]
