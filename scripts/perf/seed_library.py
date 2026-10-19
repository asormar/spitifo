#!/usr/bin/env python3
"""Fill a folder with a fake library for the performance measurements.

    python scripts/perf/seed_library.py <dir> [--count 300] [--folders 20]

Encodes one short MP3 with ffmpeg (from PATH) and copies it under
`<dir>/Perf Artist NN/Perf Track NNN.mp3`, so the library lists `--count`
real, parseable tracks spread over `--folders` folders. Every file it writes
sits under a folder whose name starts with "Perf Artist", so the seed can be
removed with `--remove` without touching anything else in `<dir>`.

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


def seed(root: Path, count: int, folders: int) -> int:
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
        for n in range(count):
            folder = root / f"{PREFIX} {n % folders:02d}"
            folder.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(sample, folder / f"Perf Track {n:03d}.mp3")
    print(f"seeded {count} tracks in {folders} folders under {root}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("dir", type=Path)
    p.add_argument("--count", type=int, default=300)
    p.add_argument("--folders", type=int, default=20)
    p.add_argument("--remove", action="store_true",
                   help="delete the seed folders instead of writing them")
    args = p.parse_args()
    if args.remove:
        return remove(args.dir)
    return seed(args.dir, args.count, args.folders)


if __name__ == "__main__":
    sys.exit(main())
