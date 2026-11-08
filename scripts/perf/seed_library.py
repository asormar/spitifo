#!/usr/bin/env python3
"""Fill a folder with a fake library for the performance measurements.

    python scripts/perf/seed_library.py <dir> [--count 300] [--folders 20] [--thumbs [N]]

Encodes one short MP3 with ffmpeg (from PATH) and copies it under
`<dir>/Perf Artist NN/Perf Track NNN.mp3`, so the library lists `--count`
real, parseable tracks spread over `--folders` folders. Every file it writes
sits under a folder whose name starts with "Perf Artist", so the seed can be
removed with `--remove` without touching anything else in `<dir>`.

`--thumbs` also writes a cover next to the first N tracks (default 100): a
480x360 JPEG of about 19 KB, the size of a YouTube `hqdefault`, saved as
`<track>.jpg`. The library then reports it as `thumb_key`, so the rows draw an
image over their tile. A real library has none for audio, only for video.

Stdlib only.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PREFIX = "Perf Artist"


def remove(root: Path) -> int:
    gone = 0
    for folder in root.glob(f"{PREFIX} *"):
        if folder.is_dir():
            shutil.rmtree(folder)
            gone += 1
    print(f"removed {gone} seed folders from {root}")
    return 0


def seed(root: Path, count: int, folders: int, thumbs: int = 0) -> int:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        sys.exit("seed_library: ffmpeg is not on PATH")
    with tempfile.TemporaryDirectory() as tmp:
        sample = Path(tmp) / "sample.mp3"
        subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i",
             "sine=frequency=440:duration=3", "-c:a", "libmp3lame", "-b:a", "64k",
             str(sample)],
            check=True,
        )
        cover = Path(tmp) / "cover.jpg"
        if thumbs:
            subprocess.run(
                [ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i",
                 "mandelbrot=size=480x360", "-frames:v", "1", "-q:v", "14",
                 str(cover)],
                check=True,
            )
        for n in range(count):
            folder = root / f"{PREFIX} {n % folders:02d}"
            folder.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(sample, folder / f"Perf Track {n:03d}.mp3")
            if n < thumbs:
                shutil.copyfile(cover, folder / f"Perf Track {n:03d}.jpg")
    covers = f", {min(thumbs, count)} with a cover" if thumbs else ""
    print(f"seeded {count} tracks in {folders} folders under {root}{covers}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("dir", type=Path)
    p.add_argument("--count", type=int, default=300)
    p.add_argument("--folders", type=int, default=20)
    p.add_argument("--thumbs", type=int, nargs="?", const=100, default=0, metavar="N",
                   help="also write a cover .jpg next to the first N tracks (default 100)")
    p.add_argument("--remove", action="store_true",
                   help="delete the seed folders instead of writing them")
    args = p.parse_args()
    if args.remove:
        return remove(args.dir)
    return seed(args.dir, args.count, args.folders, args.thumbs)


if __name__ == "__main__":
    sys.exit(main())
