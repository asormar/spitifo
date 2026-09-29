"""Identidad del archivo: `identify.similarity` y `identify.verdict`.

Offline puro: no tocan la red. Son las funciones que deciden si lo que vas a
bajar es lo que pediste, asi que sus valores son contrato de UI ("coincide" /
"NO es lo que buscabas") y van tabulados.
"""
from __future__ import annotations

import pytest

from backend.app.identify import _derive_from_name, norm, parse_id3, verdict
from backend.app.identify import similarity


@pytest.mark.parametrize("titulo,esperado", [
    # stopwords que se ignoran (live, remix, feat, version, remaster...)
    ("Bohemian Rhapsody (Official Video)", "bohemian rhapsody official video"),
    ("Numb (Live)", "numb"),
    ("  Numb  ", "numb"),
    # solo se conservan alfanumericos, la puntuacion se va a espacio
    ("Enter Sandman - Remastered!", "enter sandman remastered"),
    # la apostrofo es separador: "Don't" se parte en dos. No molesta porque
    # la comparacion es por palabra y ambos lados reciben el mismo tratamiento.
    ("Don't Stay (feat. Ashley)", "don t stay ashley"),
    # QUIRK: la lista tiene "remaster" pero NO "remastered", asi que
    # "Remastered 2015" sobrevive. Da igual: el overlap por palabra sigue
    # dando match porque "numb" esta de las dos lados. Documentado para que
    # nadie lo lea como bug al ampliar _STOP.
    ("Numb (Remastered 2015)", "numb remastered 2015"),
    ("", ""),
    (None, ""),
])
def test_norm_saca_puntuacion_y_stopwords(titulo, esperado):
    assert norm(titulo) == esperado


@pytest.mark.parametrize("a,b,esperado", [
    ("Numb", "Numb", 1.0),
    # el parenesis del video oficial no rompe el match
    ("Bohemian Rhapsody", "Bohemian Rhapsody (Official Video)", 1.0),
    ("Numb", "Numb (Live)", 1.0),
    ("Numb", "Numb (Remastered 2015) [Official Video]", 1.0),
    # el solapamiento se mide contra la parte MAS CORTA
    ("a b c", "a b c d", 1.0),
    ("a b c d e", "a b c", 1.0),
    ("a b c", "a x c", 0.5),
    ("a b c", "a x", 0.0),
    ("Numb", "In The End", 0.0),
])
def test_similarity_tabla(a, b, esperado):
    assert similarity(a, b) == pytest.approx(esperado)


@pytest.mark.parametrize("a,b", [(None, "x"), ("x", ""), (None, None)])
def test_similarity_sin_titulo_es_cero(a, b):
    """Sin titulo no hay nada que comparar: 0, nunca una excepcion."""
    assert similarity(a, b) == 0.0


@pytest.mark.parametrize("consulta,real,esperado", [
    ("Numb", "Numb", ("match", "coincide")),
    ("Bohemian Rhapsody", "Bohemian Rhapsody (Official Video)", ("match", "coincide")),
    # el caso que motivo todo identify.py: el item era del show, no la cancion
    ("Bohemian Rhapsody", "Ghost>", ("mismatch", "NO es lo que buscabas")),
    ("Numb", "Numb (Live at Milton Keynes)", ("match", "coincide")),
    ("a b c", "a x c", ("partial", "parecido")),
    ("Numb", "In The End", ("mismatch", "NO es lo que buscabas")),
    # sin identificar: NO se inventa un veredicto
    ("Numb", None, ("unknown", "no se pudo identificar")),
    ("Numb", "", ("unknown", "no se pudo identificar")),
])
def test_verdict_tabla(consulta, real, esperado):
    """`verdict` es el texto que ve la persona: los tres estados y su etiqueta."""
    assert verdict(consulta, real) == esperado


def test_verdict_es_coherente_con_similarity():
    """Los cortes (0.8 match / 0.4 partial) tienen que seguir calzando."""
    for consulta, real in [("Numb", "Numb"), ("a b c", "a x c"), ("Numb", "In The End")]:
        s = similarity(consulta, real)
        estado, _ = verdict(consulta, real)
        if s >= 0.8:
            assert estado == "match"
        elif s >= 0.4:
            assert estado == "partial"
        else:
            assert estado == "mismatch"


# ------------------------------------------------------------- lectura de tags
def test_parse_id3_lee_titulo_artista_album_anio(blob_id3):
    """Un blob ID3 armado con mutagen se lee sin bajar el archivo entero."""
    assert parse_id3(blob_id3) == {
        "title": "Numb", "artist": "Linkin Park",
        "album": "Hybrid Theory", "year": "2000",
    }


@pytest.mark.parametrize("basura", [b"", b"no soy un mp3", b"\x00" * 512])
def test_parse_id3_sin_tags_no_revienta(basura):
    """Si no hay ID3 devuelve {} y NO una excepcion: se sigue bajando el archivo."""
    assert parse_id3(basura) == {}


@pytest.mark.parametrize("nombre,esperado", [
    ("Numb.mp3", {"title": "Numb"}),
    ("setlist.flac", {"title": "setlist"}),
    # los identificadores junk de archive ("yt-1s", "gig_..._aud") no dicen la
    # cancion, pero tampoco se pueden descartar: se devuelven tal cual y el
    # llamador los marca como `derived`, que la UI NO cuenta como verificado.
    ("yt-1s.mp3", {"title": "yt-1s"}),
])
def test_derive_from_name(nombre, esperado):
    """Ultimo recurso: lo que se puede sacar del nombre del archivo."""
    assert _derive_from_name(nombre) == esperado


def test_derive_from_name_no_inventa_donde_no_hay_nada():
    """`ph2022-12-31_s3t04.mp3` es el caso de archive: el nombre NO dice la cancion.

    Se vacia el prefijo de fecha/setlist y queda un `s3t04` que es tan util
    como nada, asi que `_derive_from_name` devuelve {}. Con {} el llamador
    marca `_source="none"` y usa el titulo del ITEM, que si dice algo. Un titulo
    "s3t04" colgado en la UI seria peor que no dizer nada.
    """
    assert _derive_from_name("ph2022-12-31_s3t04.mp3") == {}
