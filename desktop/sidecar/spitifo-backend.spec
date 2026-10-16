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
from PyInstaller.utils.hooks import collect_submodules

ROOT = SPECPATH + "/../.."

# uvicorn picks its loop, protocol and lifespan implementations by name at
# runtime, so static analysis misses them.
hiddenimports = collect_submodules("uvicorn")

a = Analysis(
    [SPECPATH + "/entry.py"],
    pathex=[ROOT],
    hiddenimports=hiddenimports,
    # Test-only and unused heavy modules.
    excludes=["pytest", "tkinter", "_pytest"],
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
