#!/usr/bin/env python3
"""Rewrite the app version in every file that hardcodes it.

    python scripts/set_version.py 1.2.3

Files touched: desktop/package.json, desktop/src-tauri/tauri.conf.json,
desktop/src-tauri/Cargo.toml, desktop/src-tauri/Cargo.lock (only the app's own
[[package]] block, whose crate name is read from Cargo.toml) and
android/app/build.gradle.kts (versionName + versionCode).

Every replacement must match exactly once: a pattern that stops matching, or
starts matching twice, fails loudly instead of silently skipping a file.
Stdlib only. Line endings are preserved, so a no-op run produces no diff.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def fail(message: str) -> None:
    sys.exit(f"set_version: error: {message}")


def read(path: Path) -> str:
    # newline="" disables newline translation, so the bytes are preserved.
    with open(path, encoding="utf-8", newline="") as fh:
        return fh.read()


def write(path: Path, text: str) -> None:
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def replace_once(text: str, pattern: str, replacement: str, where: str) -> str:
    """Replace the single match of `pattern`; die unless there was exactly one."""
    new_text, count = re.subn(pattern, replacement, text)
    if count != 1:
        fail(f"{where}: expected exactly 1 match for /{pattern}/, found {count}")
    return new_text


def read_crate_name(cargo_toml: str) -> str:
    names = re.findall(r"(?m)^name\s*=\s*\"([^\"]+)\"", cargo_toml)
    if len(names) != 1:
        fail("desktop/src-tauri/Cargo.toml: expected exactly 1 [package] name, "
             f"found {len(names)}")
    return names[0]


def rewrite_cargo_lock(text: str, crate: str, version: str) -> str:
    """Rewrite the version of the app's own block in Cargo.lock.

    Every other block (dependencies) must stay untouched, so the search is
    scoped to the `[[package]]` block whose `name` is the app's crate.
    """
    blocks = list(re.finditer(
        r"(?ms)^\[\[package\]\]\r?\n.*?(?=^\[\[package\]\]|\Z)", text))
    own = [b for b in blocks
           if re.search(rf"(?m)^name = \"{re.escape(crate)}\"\r?$", b.group(0))]
    if len(own) != 1:
        fail(f"desktop/src-tauri/Cargo.lock: expected 1 [[package]] block named "
             f"'{crate}', found {len(own)}")
    block = own[0]
    body = replace_once(
        block.group(0), r"(?m)^(version\s*=\s*\")[^\"]*(\")",
        rf"\g<1>{version}\g<2>", f"Cargo.lock [[package]] {crate}")
    return text[:block.start()] + body + text[block.end():]


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        fail("usage: python scripts/set_version.py X.Y.Z")
    version = argv[1]
    match = SEMVER.match(version)
    if not match:
        fail(f"'{version}' is not a version: expected X.Y.Z (digits and dots only)")
    major, minor, patch = (int(g) for g in match.groups())
    if minor > 99 or patch > 99:
        fail(f"'{version}': minor and patch must be 0-99, because "
             "versionCode is major*10000 + minor*100 + patch")
    version_code = major * 10000 + minor * 100 + patch

    targets = [
        ROOT / "desktop/package.json",
        ROOT / "desktop/src-tauri/tauri.conf.json",
        ROOT / "desktop/src-tauri/Cargo.toml",
        ROOT / "desktop/src-tauri/Cargo.lock",
        ROOT / "android/app/build.gradle.kts",
    ]
    for path in targets:
        if not path.is_file():
            fail(f"not found: {path}")

    # package.json and tauri.conf.json both hold a top-level "version" key.
    for rel in ("desktop/package.json", "desktop/src-tauri/tauri.conf.json"):
        path = ROOT / rel
        write(path, replace_once(
            read(path), r"(?m)^(\s*\"version\"\s*:\s*\")[^\"]*(\")",
            rf"\g<1>{version}\g<2>", rel))

    cargo_toml = ROOT / "desktop/src-tauri/Cargo.toml"
    text = read(cargo_toml)
    crate = read_crate_name(text)
    write(cargo_toml, replace_once(
        text, r"(?m)^(version\s*=\s*\")[^\"]*(\")", rf"\g<1>{version}\g<2>",
        "desktop/src-tauri/Cargo.toml"))

    cargo_lock = ROOT / "desktop/src-tauri/Cargo.lock"
    write(cargo_lock, rewrite_cargo_lock(read(cargo_lock), crate, version))

    gradle = ROOT / "android/app/build.gradle.kts"
    text = read(gradle)
    text = replace_once(
        text, r"(?m)^(\s*versionName\s*=\s*\")[^\"]*(\")",
        rf"\g<1>{version}\g<2>", "android/app/build.gradle.kts versionName")
    text = replace_once(
        text, r"(?m)^(\s*versionCode\s*=\s*)\d+",
        rf"\g<1>{version_code}", "android/app/build.gradle.kts versionCode")
    write(gradle, text)

    print(f"version {version} (versionCode {version_code})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
