# PyInstaller spec for the backend sidecar that the Tauri shell starts.
#
# Build from the repository root:
#   .venv\Scripts\python -m PyInstaller desktop\sidecar\spitifo-backend.spec \
#       --distpath desktop\sidecar\dist --workpath desktop\sidecar\build
#
# One-folder build on purpose: a one-file build unpacks itself into %TEMP% on
# every launch, which adds seconds to startup and leaves files behind when the
# process is killed. The frontend and ffmpeg are not bundled here; the shell
# ships them as resources and points the backend at them.
from PyInstaller.utils.hooks import collect_submodules, copy_metadata
import os

ROOT = SPECPATH + "/../.."

# uvicorn picks its loop, protocol and lifespan implementations by name at
# runtime, so static analysis misses them.
hiddenimports = collect_submodules("uvicorn")

# The desktop app signs in to Drive with a client that is NOT in the repository
# (backend/app/cloud/oauth_clients.json is gitignored; CI writes it from
# secrets). oauth.py looks for it next to its own module first, so it has to sit
# at the same package path inside the bundle. Optional: without the file the
# Google source is simply unavailable, and nothing else breaks.
oauth_clients = os.path.join(ROOT, "backend", "app", "cloud", "oauth_clients.json")
datas = [(oauth_clients, "backend/app/cloud")] if os.path.exists(oauth_clients) else []

# yt-dlp's dist-info: runtime.bundled_ytdlp_version() reads it so the
# auto-updater never loads a downloaded yt-dlp older than the bundled one (the
# PYZ keeps bytecode only, so version.py cannot be read from it).
datas += copy_metadata("yt-dlp")

a = Analysis(
    [SPECPATH + "/entry.py"],
    pathex=[ROOT],
    datas=datas,
    hiddenimports=hiddenimports,
    # Test-only and unused heavy modules. Measured in session 20:
    # - pygments: only the httpx command-line tool imports it.
    # - sqlite3: yt-dlp uses it only to read cookies from a browser profile;
    #   the app passes a cookies.txt file instead.
    # - watchfiles, yaml, websockets, httptools, dotenv: uvicorn[standard]
    #   extras for --reload, YAML log config, WebSockets, the C HTTP parser and
    #   .env files. The app uses none of them; uvicorn falls back to h11.
    # - bz2, lzma: zipfile imports both defensively in try/except, so PyInstaller
    #   collects them even though no runtime code uses them (grep of backend and
    #   of yt-dlp, starlette, uvicorn, httpx, mutagen and their dependencies).
    #   zipfile sets each to None when absent, and the yt-dlp update archive is
    #   a deflate zip, so dropping them is safe. Measured in the 3.11 build:
    #   _bz2.pyd 72,704 B + _lzma.pyd 152,576 B = 225,280 B out of _internal.
    # pytest/pydoc/doctest/distutils are already absent from the PYZ, and
    # OpenSSL (libcrypto + libssl + _ssl) is required by httpx for HTTPS: there
    # is no second copy of either DLL to remove.
    excludes=["pytest", "tkinter", "_pytest", "pygments", "sqlite3", "_sqlite3",
              "watchfiles", "yaml", "_yaml", "websockets", "httptools",
              "dotenv", "bz2", "lzma"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="spitifo-backend",
    console=True,  # stdout carries the SPITIFO_READY line; the shell hides the window
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="spitifo-backend", upx=False)
