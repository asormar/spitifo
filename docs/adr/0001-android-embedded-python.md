# ADR 0001: Run the existing Python backend inside the Android app

- **Status:** Accepted
- **Date:** 2026-10-16
- **Context:** roadmap session 1 (Android feasibility spike), branch
  `spike/android-chaquopy`. The spike code is throwaway and is not merged.

## Decision

**Go with Chaquopy.** The Android app embeds CPython with Chaquopy, runs the
existing backend on `127.0.0.1` and shows the existing React UI in a WebView.
Plan B (`youtubedl-android` plus porting search and matching to Kotlin) is not
needed.

Two conditions come with it:

1. **FastAPI is replaced by Starlette** in `backend/app/main.py` (roadmap
   session 3). FastAPI depends on pydantic v2, whose native core has no Android
   build.
2. **Downloads run inside a foreground service** (roadmap session 5). Without
   one, Android cuts the app's network as soon as the screen turns off.

## Test setup

- Pixel 9 Pro, Android 16 (API 36), arm64-v8a, on 4G.
- Chaquopy 17.0.0, Python 3.12, AGP 8.13, Gradle 8.13, compileSdk/targetSdk 34.
- yt-dlp 2026.8.19, starlette 1.8.0, uvicorn 0.54.0 (no extras), httpx 0.28.1,
  mutagen 1.48.1.
- Every module under `backend/app/` except `main.py` ran unchanged. `main.py`
  was replaced by a 1:1 Starlette port of its routes.

## Findings

### pydantic-core has no Android wheel

`pydantic-core` is Rust. Neither Chaquopy's package repository nor PyPI ships an
Android wheel (2.50.1 ships only manylinux, musllinux, Windows, macOS and
emscripten wheels), and manylinux wheels do not load on Android's libc.

Only `main.py` imports FastAPI or pydantic; the rest of the backend is plain
Python with dataclasses. The two pydantic models (`DownloadReq`, `TrackPayload`)
validate small request bodies, so pydantic's speed is irrelevant here.

Rejected alternative: cross-compiling `pydantic-core` with Rust and the Android
NDK. It keeps `main.py` untouched, but every pydantic upgrade would need a new
cross-build, in CI as well.

### Startup and search

| Measurement | Result |
| --- | --- |
| Cold start to backend ready | 0.63 s after `onCreate` (1.7 s in the build with ffmpeg) |
| Search, matched mode | 4.1–4.3 s |
| Search, YouTube mode | 2.6–2.9 s |

### yt-dlp

- `bestaudio` downloads from YouTube worked **without a JavaScript runtime**
  (Deno).
- One download failed with `HTTP Error 403: Forbidden` and succeeded on an
  immediate retry. This is YouTube's anti-bot behaviour, not an Android issue.

### ffmpeg

- Source: `io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1` from Maven
  Central (the build used by the Seal app), ffmpeg and ffprobe 7.1.1.
- `libffmpeg.so` and `libffprobe.so` are PIE executables. Android blocks
  executing files from app data directories (W^X), but allows it from the
  native library directory, so they ship with `extractNativeLibs="true"`.
- Their shared libraries come zipped (`libffmpeg.zip.so`, 35.6 MB) and are
  extracted on first launch. Five libraries they need are missing from that
  payload and come from the same publisher's `library` artifact.
- Symlinks named `ffmpeg` and `ffprobe` on `PATH` let the unchanged backend find
  them with `shutil.which`.

| Format | Time | Size | Result |
| --- | --- | --- | --- |
| mp3 | 39.5 s | 6.7 MiB | MP3 ~193 kbps, tags written |
| m4a | 29.9 s | 14.2 MiB | AAC in M4A, tags written |
| original | 35.9 s | 6.7 MiB | MP3: `ytdlp_source.py` always runs `FFmpegExtractAudio` |

### Screen off

| Test | Without foreground service | With foreground service |
| --- | --- | --- |
| Screen on (control) | Done in 15.2 s | — |
| Screen off, USB powered | **Fails at once**: `[Errno 7] No address associated with hostname` | Done in 15.4 s |
| Forced deep Doze (`dumpsys deviceidle force-idle`) | — | Done in 16.6 s |
| Unplugged, screen off for 73 s | — | Done: 30-minute audio, 35.4 MB mp3 |

With the screen off the app drops to a cached process state and Android blocks
its network (`blocked=APP_BACKGROUND|METERED_USER_RESTRICTED` in
`dumpsys netpolicy`). A foreground service of type `dataSync` plus a partial
wake lock keeps both the network and the CPU running.

### Size

| Build | APK | Installed |
| --- | --- | --- |
| Without ffmpeg | 27.8 MiB | ~44 MB |
| With ffmpeg | 56.4 MiB | ~96 MB of app data, ~78 MB of it the extracted ffmpeg libraries |

The ffmpeg payload ships every library in the artifact. Only the ones the two
executables actually load are needed.

## Consequences

- **Session 3 (embeddable backend):**
  - Port `main.py` from FastAPI to Starlette, keeping routes, parameters,
    status codes and JSON shapes, so the same backend runs on PC and Android.
  - `backend/app/__init__.py` imports `main`; keep the package importable
    without the HTTP layer.
  - Retry yt-dlp downloads automatically on transient errors such as HTTP 403.
  - Skip `FFmpegExtractAudio` when the format is `original`, so YouTube audio
    keeps its source codec.
  - Serve correct MIME types on Android, which has no system MIME database
    (`.ogg` was served as `application/octet-stream`).
  - Injectable frontend and ffmpeg locations (the spike used environment
    variables and `PATH`).
- **Session 5 (Android app):**
  - Start the foreground service when a download starts and stop it when the
    queue is empty. On targetSdk 35+, `dataSync` services are capped at 6 hours
    a day.
  - Request `POST_NOTIFICATIONS` so the progress notification is visible.
  - Trim the ffmpeg payload to the libraries the executables load.
- **Risk accepted:** the APK is above 50 MB. It is distributed outside Google
  Play, so this only affects download size.
