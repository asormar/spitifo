"""Descarga de audio: stream a disco, tags ID3, conversion opcional con ffmpeg."""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import httpx

from .config import AUDIO_EXTS, USER_AGENT
from .models import Track, safe_name

log = logging.getLogger("spitifo.download")

LIBRARY = Path(os.getenv("SPITIFO_LIBRARY", Path(__file__).resolve().parents[2] / "library"))
LIBRARY.mkdir(parents=True, exist_ok=True)

# Carpeta OPCIONAL para los archivos temporales de descarga. En Android la
# biblioteca vive en la carpeta publica Music/Spitifo (FUSE), que rechaza los
# temporales de yt-dlp (.part/.webm): su MIME no es audio. Ademas os.replace
# falla con EXDEV cuando el temporal esta en /data y el destino en /storage.
# Con SPITIFO_TEMP_DIR los temporales viven en la particion privada y el
# archivo final se publica con shutil.move, que si cruza filesystems. Sin la
# variable, todo sigue exactamente como antes (temp file dentro del artista).
# Ver docs/adr/0001-android-embedded-python.md.
_temporal = os.getenv("SPITIFO_TEMP_DIR", "")
TEMP_DIR: Path | None = Path(_temporal) if _temporal else None
if TEMP_DIR is not None:
    TEMP_DIR.mkdir(parents=True, exist_ok=True)

# Codec que corresponde a cada formato pedido. Antes se usaba libmp3lame para
# todo, asi que pedir m4a daba un .m4a con audio MP3 dentro.
#
# `+faststart` mueve el atom `moov` (el indice) al principio del M4A. Sin eso
# ffmpeg lo escribe al FINAL y el reproductor tiene que pedir el final del
# archivo antes de poder empezar a sonar (docs/adr/0002, "Playback speed").
ENCODERS = {
    ".mp3": ["-codec:a", "libmp3lame", "-q:a", "2"],
    ".m4a": ["-codec:a", "aac", "-b:a", "256k", "-movflags", "+faststart"],
}


def _ffmpeg_ok() -> bool:
    return shutil.which("ffmpeg") is not None


async def _download_to(url: str, dest: Path,
                       progress: "asyncio.Queue | None" = None) -> Path:
    timeout = httpx.Timeout(300.0, connect=15.0, read=60.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True,
                                 headers={"User-Agent": USER_AGENT}) as c:
        async with c.stream("GET", url) as r:
            r.raise_for_status()
            total = int(r.headers.get("content-length") or 0)
            got = 0
            with open(dest, "wb") as f:
                async for chunk in r.aiter_bytes(65536):
                    f.write(chunk)
                    got += len(chunk)
                    if progress is not None and total:
                        await progress.put((got, total))
    return dest


def _write_tags(path: Path, t: Track) -> None:
    try:
        from mutagen import File as MFile
        from mutagen.id3 import (TIT2, TPE1, TALB, TDRC, TCON, APIC,
                                 ID3, ID3NoHeaderError)
        from mutagen.flac import FLAC, Picture
        from mutagen.mp4 import MP4, MP4Cover

        ext = path.suffix.lower()
        if ext == ".mp3":
            try:
                id3 = ID3(path)
            except ID3NoHeaderError:
                id3 = ID3()
            if t.title:
                id3.add(TIT2(encoding=3, text=t.title))
            if t.artist:
                id3.add(TPE1(encoding=3, text=t.artist))
            if t.album:
                id3.add(TALB(encoding=3, text=t.album))
            if t.year:
                id3.add(TDRC(encoding=3, text=t.year))
            if t.license:
                id3.add(TCON(encoding=3, text=t.license))
            id3.save(path, v2_version=3)
        elif ext == ".flac":
            f = FLAC(path)
            if t.title:
                f["title"] = t.title
            if t.artist:
                f["artist"] = t.artist
            if t.album:
                f["album"] = t.album
            if t.year:
                f["date"] = t.year
            f.save()
        elif ext in (".m4a", ".mp4"):
            f = MP4(path)
            if t.title:
                f["\xa9nam"] = t.title
            if t.artist:
                f["\xa9ART"] = t.artist
            if t.album:
                f["\xa9alb"] = t.album
            f.save()
        elif ext in (".ogg", ".opus"):
            # Vorbis comments: mismo esquema de claves que FLAC.
            f = MFile(path)
            if f is not None:
                if f.tags is None:
                    f.add_tags()
                for k, v in (("title", t.title), ("artist", t.artist),
                             ("album", t.album), ("date", t.year)):
                    if v:
                        f[k] = str(v)
                f.save()
    except Exception as e:  # tags son un extra, no deben tumbar la descarga
        log.warning("tags fallaron en %s: %s", os.path.basename(str(path)), e)


def _ffmpeg_convert(src: Path, out_path: Path) -> Path:
    """Convierte al formato de out_path (MP3 ~V2 o AAC 256k en M4A).

    out_path define el nombre final y, por su extension, el codec."""
    enc = ENCODERS.get(out_path.suffix.lower())
    if enc is None:
        raise ValueError(f"formato de salida no soportado: {out_path.suffix}")
    cmd = ["ffmpeg", "-y", "-i", str(src), "-vn", *enc, str(out_path)]
    subprocess.run(cmd, check=True, capture_output=True)
    return out_path


async def download_track(t: Track, fmt: str = "original") -> dict:
    """Descarga la pista a la biblioteca. fmt: original|mp3|m4a.

    "original" guarda el archivo tal cual lo publica la fuente (FLAC, OGG,
    WAV...), sin recodificar. mp3/m4a convierten solo si el origen no lo es ya.

    Devuelve dict con ruta, bytes, formato.
    """
    if not t.audio_url:
        raise ValueError("la pista no tiene audio_url (no es descargable)")

    # Si los tags dijeron el titulo REAL (p.ej. "Ghost>") y el match no es bueno,
    # usar el real: el archivo en disco no debe mentir.
    real = t.extra.get("real_title")
    swapped = bool(real) and t.extra.get("match") in ("mismatch", "unknown")
    if swapped:
        base_title = real
        base_artist = t.extra.get("real_artist") or t.artist
    else:
        base_title = t.title
        base_artist = t.artist

    folder = LIBRARY / safe_name(base_artist or "desconocido", 60)
    folder.mkdir(parents=True, exist_ok=True)

    src_ext = Path(t.audio_url.split("?")[0]).suffix.lower() or ".mp3"
    if len(src_ext) > 5 or not src_ext.startswith("."):
        src_ext = ".mp3"
    stem = safe_name(f"{base_artist} - {base_title}", 100)
    # Donde se arma el archivo antes de publicarlo en la biblioteca. Sin
    # SPITIFO_TEMP_DIR es la propia carpeta del artista (comportamiento de
    # siempre); con la variable, la carpeta temporal de la app.
    work = TEMP_DIR if TEMP_DIR is not None else folder
    tmp = work / f".{uuid.uuid4().hex[:8]}{src_ext}"
    tmp_conv: Path | None = None
    final: Path

    try:
        await _download_to(t.audio_url, tmp)

        # "original" no toca el archivo. Antes un FLAC u OGG se pasaba a MP3
        # igual que con fmt=mp3 en cuanto habia ffmpeg: la opcion no hacia nada.
        target_ext = f".{fmt}" if fmt in ("mp3", "m4a") else src_ext

        needs_conv = target_ext != src_ext
        if needs_conv and not _ffmpeg_ok():
            log.warning("ffmpeg ausente, se guarda en %s", src_ext)
            target_ext = src_ext
            needs_conv = False

        final = folder / f"{stem}{target_ext}"

        if TEMP_DIR is not None:
            # Todo el trabajo (descarga, conversion y tags) pasa en TEMP_DIR:
            # la carpeta publica solo recibe el archivo ya terminado, con un
            # move que atraviesa filesystems.
            if needs_conv:
                tmp_conv = work / f".{uuid.uuid4().hex[:8]}{target_ext}"
                await asyncio.to_thread(_ffmpeg_convert, tmp, tmp_conv)
                terminado = tmp_conv
            else:
                terminado = tmp
            _write_tags(terminado, t)
            await asyncio.to_thread(shutil.move, terminado, final)
        else:
            # Sin TEMP_DIR: mismo flujo de siempre, pero con shutil.move en vez
            # de os.replace (sobreescribe el final igual y ademas cruza
            # filesystems si hiciera falta).
            if needs_conv:
                await asyncio.to_thread(_ffmpeg_convert, tmp, final)
            else:
                await asyncio.to_thread(shutil.move, tmp, final)
            _write_tags(final, t)

        size = final.stat().st_size
        return {
            "path": str(final), "filename": final.name,
            "folder": str(folder), "bytes": size,
            "size_mb": round(size / 1_048_576, 2),
            "format": final.suffix.lstrip(".").upper(),
        }
    finally:
        # Los temporales que hayan quedado (error, o el src de una conversion)
        # se limpian siempre; `tmp` puede haber sido movido ya al final.
        for p in (tmp, tmp_conv):
            if p is not None and p.exists():
                try:
                    p.unlink()
                except OSError:
                    pass


def library_scan() -> list[dict]:
    """Lista la biblioteca local ya descargada, con la duracion real."""
    exts = set(AUDIO_EXTS)
    out = []
    for p in LIBRARY.rglob("*"):
        if p.is_file() and p.suffix.lower() in exts:
            st = p.stat()
            out.append({
                "filename": p.name,
                "path": str(p),
                "folder": p.parent.name,
                "bytes": st.st_size,
                "size_mb": round(st.st_size / 1_048_576, 2),
                "duration_s": _duration(p),
                "modified": st.st_mtime,
            })
    return sorted(out, key=lambda x: -x["modified"])


def _duration(p: Path) -> float | None:
    """Duracion real en segundos, leida con mutagen. None si no se puede."""
    try:
        from mutagen import File as MFile
        f = MFile(p)
        if f is not None and f.info is not None:
            return round(float(f.info.length), 1)
    except Exception:
        pass
    return None
