"""Enlaces de YouTube pegados en el buscador: local, sin red."""
from __future__ import annotations

import pytest

from backend.app.ytdlp_source import identity_query, parse_youtube_url, thumbnail_url

VIDEO = "https://www.youtube.com/watch?v=eBG7P-K-r1Y"


@pytest.mark.parametrize("entrada", [
    "https://www.youtube.com/watch?v=eBG7P-K-r1Y",
    "youtube.com/watch?v=eBG7P-K-r1Y",
    "https://youtu.be/eBG7P-K-r1Y?si=abc123",
    "https://m.youtube.com/watch?feature=share&v=eBG7P-K-r1Y",
    "https://music.youtube.com/watch?v=eBG7P-K-r1Y&list=RDAMVM",
    "https://www.youtube.com/shorts/eBG7P-K-r1Y",
    "https://www.youtube.com/embed/eBG7P-K-r1Y",
    "  https://youtu.be/eBG7P-K-r1Y  ",
])
def test_parse_video_da_la_url_canonica(entrada):
    """Todas las formas de compartir un video acaban en la misma URL; un
    `&list=` no convierte el video en su playlist."""
    assert parse_youtube_url(entrada) == VIDEO


def test_parse_playlist_pura():
    assert parse_youtube_url("https://www.youtube.com/playlist?list=PLx_y-1") == \
        "https://www.youtube.com/playlist?list=PLx_y-1"


@pytest.mark.parametrize("entrada", [
    "foo fighters everlong",
    "https://vimeo.com/123456",
    "https://www.youtube.com/watch?v=corto",       # ID que no tiene 11 caracteres
    "https://www.youtube.com/@foofighters",         # canal, no video
    "https://evil.com/youtube.com/watch?v=eBG7P-K-r1Y",
])
def test_parse_no_es_video(entrada):
    assert parse_youtube_url(entrada) is None


def test_identity_query_con_url_usa_el_titulo():
    """Con un enlace se pidio ESE video: comparar la URL con el titulo daria
    siempre "no coincide"."""
    assert identity_query("https://youtu.be/eBG7P-K-r1Y", "Everlong") == "Everlong"
    assert identity_query("everlong live", "Everlong") == "everlong live"
    assert identity_query(None, "Everlong") == "Everlong"


def test_thumbnail_url():
    assert thumbnail_url("eBG7P-K-r1Y") == "https://i.ytimg.com/vi/eBG7P-K-r1Y/hqdefault.jpg"
