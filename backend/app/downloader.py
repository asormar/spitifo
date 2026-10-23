"""Descarga de audio: stream a disco, tags ID3, conversion opcional con ffmpeg."""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

import httpx

from .config import IMAGE_EXTS, USER_AGENT, VIDEO_EXTS
from .models import Track, safe_name
from .storage import get_storage

log = logging.getLogger("spitifo.download")

# Carpeta base para los archivos temporales de descarga. En Android la
# biblioteca vive en la carpeta publica Music/Spitifo (FUSE), que rechaza los
# temporales de yt-dlp (.part/.webm): su MIME no es audio. Ademas os.replace
# falla con EXDEV cuando el temporal esta en /data y el destino en /storage.
# Con SPITIFO_TEMP_DIR los temporales viven en la particion privada; sin la
# variable van al directorio temporal del sistema. Cada descarga arma su PROPIA
# subcarpeta ahi adentro (tempfile.mkdtemp) y la borra entera al terminar: el
# .part de una descarga nunca se cruza con el de otra.
# Ver docs/adr/0001-android-embedded-python.md y docs/adr/0002-user-owned-storage.md.
TEMP_DIR = Path(os.getenv("SPITIFO_TEMP_DIR")
                or (Path(tempfile.gettempdir()) / "spitifo"))
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

    Todo el trabajo (bajada, conversion y tags) pasa en una subcarpeta propia de
    TEMP_DIR y recien el archivo terminado entra a la biblioteca por el puerto
    `Storage`. Devuelve la clave relativa (no una ruta), bytes y formato.
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

    folder = safe_name(base_artist or "desconocido", 60)

    src_ext = Path(t.audio_url.split("?")[0]).suffix.lower() or ".mp3"
    if len(src_ext) > 5 or not src_ext.startswith("."):
        src_ext = ".mp3"
    stem = safe_name(f"{base_artist} - {base_title}", 100)

    # Subcarpeta fresca y exclusiva de esta descarga: asi el .part de un job no
    # se cruza con el de otro (aunque sean la misma pista) y no quedan restos
    # dentro de la carpeta publica de la biblioteca.
    work = Path(tempfile.mkdtemp(dir=TEMP_DIR))
    tmp = work / f".{uuid.uuid4().hex[:8]}{src_ext}"
    tmp_conv: Path | None = None

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

        if needs_conv:
            tmp_conv = work / f".{uuid.uuid4().hex[:8]}{target_ext}"
            await asyncio.to_thread(_ffmpeg_convert, tmp, tmp_conv)
            terminado = tmp_conv
        else:
            terminado = tmp
        _write_tags(terminado, t)

        filename = f"{stem}{target_ext}"
        key = f"{folder}/{filename}"
        stored = await asyncio.to_thread(get_storage().put_file, key, terminado)
        size = stored.size
        return {
            "key": key, "filename": filename, "folder": folder,
            "bytes": size, "size_mb": round(size / 1_048_576, 2),
            "format": target_ext.lstrip(".").upper(),
        }
    finally:
        # Toda la subcarpeta de trabajo se limpia: temporales, el src de una
        # conversion y, si algo fallo, la descarga a medias.
        shutil.rmtree(work, ignore_errors=True)


def _thumb_sidecar(key: str) -> str:
    """Clave del sidecar `.jpg` de una clave de media (mismo nombre, otra ext).

    Se arma sobre POSIX (`/`) y no con `Path`: en Windows `Path` metería
    backslashes y la clave dejaría de coincidir con la del `Storage`.
    """
    nombre = key.rsplit("/", 1)[-1]
    base = key[: len(key) - len(nombre)] + (
        nombre.rsplit(".", 1)[0] if "." in nombre else nombre)
    return base + ".jpg"


def library_scan() -> list[dict]:
    """Lista la biblioteca terminada a traves del puerto, con la duracion real.

    Devuelve audio y video. Cada entrada suma `kind` (audio/video), `thumb_key`
    (la miniatura `.jpg` que existe al lado, o None) y `has_audio` (False solo
    en un video "sin audio": el que bajo `media=video`). Los `.jpg` NO se listan
    como temas: son sidecars, asi que uno huerfano queda oculto.
    """
    files = list(get_storage().list())
    thumbs = {f.key for f in files if Path(f.key).suffix.lower() in IMAGE_EXTS}
    out = []
    for f in files:
        ext = Path(f.key).suffix.lower()
        if ext in IMAGE_EXTS:
            continue  # huerfano o sidecar: lo resuelve `thumb_key` de su video
        partes = f.key.split("/")
        sidecar = _thumb_sidecar(f.key)
        es_video = ext in VIDEO_EXTS
        out.append({
            "key": f.key,
            "filename": partes[-1],
            "folder": partes[-2] if len(partes) > 1 else "",
            "bytes": f.size,
            "size_mb": round(f.size / 1_048_576, 2),
            "duration_s": f.duration,
            # Etiquetas del archivo (None si no tiene): Escuchar agrupa con
            # ellas y, si faltan, cae a la carpeta y al nombre.
            "title": f.title,
            "artist": f.artist,
            "album": f.album,
            "modified": f.mtime,
            "kind": "video" if es_video else "audio",
            "thumb_key": sidecar if sidecar in thumbs else None,
            # Un video "sin audio" lo dice su propio nombre. El resto (audio y
            # el mp4 del modo "both") tiene pista de sonido.
            "has_audio": not (es_video and Path(partes[-1]).stem.endswith(" (sin audio)")),
        })
    return sorted(out, key=lambda x: -x["modified"])
