"""El selector de formato de yt-dlp, corrido por el motor REAL de yt-dlp.

`media_selector` es una cadena; comparar la cadena no prueba nada. Aca se le da
al selector de yt-dlp una lista de formatos como la de un video real (verificada
contra YouTube) y se mira CUAL elige. Es offline: no baja nada.

Dos bugs que esto atrapa y que solo se vieron contra YouTube de verdad:
- pedir 1440p o 4K bajaba un 1080p avc1 en silencio (el primer intento era
  "mp4 avc1 con altura <= H" y YouTube no publica avc1 por encima de 1080p);
- 360p elegia el formato 18 (progresivo, con audio), que YouTube hoy rechaza
  con 403, en vez del video-solo 134.
"""
from __future__ import annotations

import pytest
import yt_dlp
from yt_dlp.utils import YoutubeDLError

from backend.app.ytdlp_source import media_selector


def _video(fid, height, ext, vcodec):
    return {"format_id": fid, "url": f"https://v/{fid}", "ext": ext,
            "height": height, "width": height * 16 // 9, "vcodec": vcodec,
            "acodec": "none", "fps": 24, "protocol": "https",
            "tbr": height, "format_note": f"{height}p"}


def _audio(fid, ext, acodec, abr):
    return {"format_id": fid, "url": f"https://a/{fid}", "ext": ext,
            "vcodec": "none", "acodec": acodec, "abr": abr, "tbr": abr,
            "protocol": "https", "format_note": "medium"}


# Mismo reparto que un video real de YouTube (kXYiU_JCYtU, mirado el 2026-10-18).
FORMATOS = [
    _audio("140", "m4a", "mp4a.40.2", 129),
    _audio("251", "webm", "opus", 135),
    _video("160", 144, "mp4", "avc1.4d400c"),
    _video("133", 240, "mp4", "avc1.4d4015"),
    _video("134", 360, "mp4", "avc1.4d401e"),
    _video("135", 480, "mp4", "avc1.4d401f"),
    _video("136", 720, "mp4", "avc1.4d401f"),
    _video("137", 1080, "mp4", "avc1.640028"),
    _video("271", 1440, "webm", "vp9"),
    _video("313", 2160, "webm", "vp9"),
    _video("401", 2160, "mp4", "av01.0.12M.08"),  # AV1: no debe elegirse
    # Progresivo (video + audio juntos): YouTube lo rechaza con 403.
    {**_video("18", 360, "mp4", "avc1.42001E"), "acodec": "mp4a.40.2"},
]


def _elige(media, height=None):
    """IDs de formato que el motor de yt-dlp elige con este selector."""
    info = {"id": "x", "title": "t", "extractor": "youtube", "webpage_url": "https://y/x",
            "formats": [dict(f) for f in FORMATOS]}
    opts = {"quiet": True, "no_warnings": True, "format": media_selector(media, height),
            "merge_output_format": "mp4"}
    with yt_dlp.YoutubeDL(opts) as ydl:
        out = ydl.process_video_result(info, download=False)
    return [f["format_id"] for f in (out.get("requested_formats") or [out])]


@pytest.mark.parametrize("height,video", [
    (144, "160"), (240, "133"), (360, "134"), (480, "135"),
    (720, "136"), (1080, "137"), (1440, "271"), (2160, "313"),
])
def test_both_elige_exactamente_la_altura_pedida(height, video):
    assert _elige("both", height) == [video, "140"]


@pytest.mark.parametrize("height,video", [
    (360, "134"), (1080, "137"), (1440, "271"), (2160, "313"),
])
def test_video_elige_solo_el_stream_de_video(height, video):
    assert _elige("video", height) == [video]


def test_360_no_cae_en_el_progresivo_que_da_403():
    assert "18" not in _elige("both", 360)
    assert "18" not in _elige("video", 360)


def test_sin_height_es_lo_mejor_que_haya_y_sin_av1():
    assert _elige("video") == ["313"]
    assert _elige("both") == ["313", "140"]


def test_una_altura_que_no_existe_baja_a_la_inmediata_inferior_nunca_a_una_mayor():
    assert _elige("video", 900) == ["136"]
    assert _elige("both", 1000) == ["136", "140"]


def test_sin_nada_que_entre_en_el_limite_falla_en_vez_de_subir():
    with pytest.raises(YoutubeDLError):
        _elige("video", 100)
