#!/usr/bin/env python3
"""Fill a folder with a fake library for the performance measurements.

    python scripts/perf/seed_library.py <dir> [--count 300] [--folders 20] [--thumbs [N]]
                                        [--small-thumbs] [--verdicts]

Encodes one short MP3 with ffmpeg (from PATH) and copies it under
`<dir>/Perf Artist NN/Perf Track NNN.mp3`, so the library lists `--count`
real, parseable tracks spread over `--folders` folders. Every file it writes
sits under a folder whose name starts with "Perf Artist", so the seed can be
removed with `--remove` without touching anything else in `<dir>`.

`--thumbs` also writes a cover next to the first N tracks (default 100): a
480x360 JPEG of about 19 KB, the size of a YouTube `hqdefault`, saved as
`<track>.jpg`. The library then reports it as `thumb_key`, so the rows draw an
image over their tile. `--small-thumbs` adds the ~100 px `<track>.s.jpg` next
to each of them (the library then reports `thumb_s`).

`--verdicts` writes the stored verdicts a download leaves behind: one record
per track in `<dir>/.spitifo/fileinfo-perf-seed-<YYYY-MM>.json` (mostly
Coincide, about 12 % Parecido / No coincide with the title the file really
has, a few unreadable ones), with the same byte size as the file. `/api/library`
then carries `verdict`, `meta_src`, `file_src` and `real` on every row, which
is the worst case for the payload. `--remove` deletes those shards too.

Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PREFIX = "Perf Artist"
SHARD_PREFIX = "fileinfo-perf-seed-"
#: Seeded `at` (seconds): 2026-10-09 UTC. One shard is enough for the seed.
SEED_AT = 1_791_500_000
SEED_MONTH = "2026-10"


def verdict_record(n: int, size: int) -> dict:
    """The record a download of track `n` would have left. Deterministic mix."""
    pick = n % 25
    verdict = "partial" if pick in (3, 11, 19) else "mismatch" if pick == 7 else (
        "unknown" if pick == 23 else "match")
    record = {"verdict": verdict, "at": SEED_AT + n, "bytes": size,
              "meta": "itunes", "file": "youtube",
              "title": f"Perf Track {n:03d}", "artist": f"Perf Artist {n % 20:02d}",
              "meta_url": "https://music.apple.com/ar/song/perf",
              "file_url": "https://www.youtube.com/watch?v=perfperf000", "score": 0.9}
    if verdict in ("partial", "mismatch"):
        record["real"] = f"Perf Track {n:03d} (Official Video) - Perf Artist"
        record["real_by"] = "video"
        record["score"] = 0.5
    return record


def remove(root: Path) -> int:
    gone = 0
    for folder in root.glob(f"{PREFIX} *"):
        if folder.is_dir():
            shutil.rmtree(folder)
            gone += 1
    for shard in (root / ".spitifo").glob(f"{SHARD_PREFIX}*.json"):
        shard.unlink()
    print(f"removed {gone} seed folders from {root}")
    return 0


def seed(root: Path, count: int, folders: int, thumbs: int = 0,
         small_thumbs: bool = False, verdicts: bool = False) -> int:
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
        small = Path(tmp) / "small.jpg"
        if thumbs and small_thumbs:
            subprocess.run(
                [ffmpeg, "-v", "error", "-y", "-i", str(cover), "-vf", "scale=100:75",
                 "-q:v", "6", str(small)],
                check=True,
            )
        size = sample.stat().st_size
        records = {}
        for n in range(count):
            folder = root / f"{PREFIX} {n % folders:02d}"
            folder.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(sample, folder / f"Perf Track {n:03d}.mp3")
            if n < thumbs:
                shutil.copyfile(cover, folder / f"Perf Track {n:03d}.jpg")
                if small_thumbs:
                    shutil.copyfile(small, folder / f"Perf Track {n:03d}.s.jpg")
            if verdicts:
                key = f"{PREFIX} {n % folders:02d}/Perf Track {n:03d}.mp3"
                records[key] = verdict_record(n, size)
        if verdicts:
            state = root / ".spitifo"
            state.mkdir(parents=True, exist_ok=True)
            shard = state / f"{SHARD_PREFIX}{SEED_MONTH}.json"
            shard.write_text(json.dumps({"version": 1, "files": records},
                                        sort_keys=True, separators=(",", ":")),
                             encoding="utf-8")
    covers = f", {min(thumbs, count)} with a cover" if thumbs else ""
    checks = ", with stored verdicts" if verdicts else ""
    print(f"seeded {count} tracks in {folders} folders under {root}{covers}{checks}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("dir", type=Path)
    p.add_argument("--count", type=int, default=300)
    p.add_argument("--folders", type=int, default=20)
    p.add_argument("--thumbs", type=int, nargs="?", const=100, default=0, metavar="N",
                   help="also write a cover .jpg next to the first N tracks (default 100)")
    p.add_argument("--small-thumbs", action="store_true",
                   help="with --thumbs, also write the ~100 px <track>.s.jpg")
    p.add_argument("--verdicts", action="store_true",
                   help="also write the stored verdict of every track (.spitifo/fileinfo-*)")
    p.add_argument("--remove", action="store_true",
                   help="delete the seed folders instead of writing them")
    args = p.parse_args()
    if args.remove:
        return remove(args.dir)
    return seed(args.dir, args.count, args.folders, args.thumbs,
                args.small_thumbs, args.verdicts)


if __name__ == "__main__":
    sys.exit(main())
