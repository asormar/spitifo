"""PyInstaller entry point for the desktop sidecar.

PyInstaller needs a script, not `-m backend.app`, so this file only forwards to
the embeddable entry point. All configuration arrives through the `SPITIFO_*`
environment variables that the Tauri shell sets.
"""
import multiprocessing
import sys

from backend.app.__main__ import main

if __name__ == "__main__":
    # Frozen Windows builds re-run this script in any child process; without
    # this call a stray multiprocessing import would start a second server.
    multiprocessing.freeze_support()
    sys.exit(main())
