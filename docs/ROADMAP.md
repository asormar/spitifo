# Roadmap: native apps and user-owned storage

Spitifo is going from a local web app to installable apps for **PC and Android**
that work on their own, with no central server. Each user keeps their music on
their own device by default and can connect their own cloud storage.

Decided on 2026-10-15.

## Guiding decision: one backend everywhere

The engine (FastAPI + yt-dlp + ffmpeg) is Python and cannot run inside a browser
or a PWA. Instead of rewriting it per platform, **the existing backend ships inside
each app**, and the React UI talks to it over `localhost`, exactly as it does today.

| Platform | Shell | Backend |
| --- | --- | --- |
| PC (Windows first) | Tauri | PyInstaller build, run as a sidecar process |
| Android | WebView / Capacitor | Embedded Python via Chaquopy |

One codebase to maintain. The risky part was Android, which is why session 1 was
a feasibility spike. It passed: see
[ADR 0001](adr/0001-android-embedded-python.md).

### Rejected alternatives

- **Central server:** the maintainer would have to run storage and compute for
  everyone, YouTube blocks yt-dlp from datacenter IPs, and a public downloader
  carries legal risk.
- **The user's PC as the server for the phone:** simple, but the phone would only
  work while the PC is on.

## Sessions

### 1. Android feasibility spike (go / no-go) — done: go with Chaquopy

Result and measurements in [ADR 0001](adr/0001-android-embedded-python.md).

- **Goal:** a throwaway APK that searches and downloads a song with yt-dlp and
  ffmpeg running inside the app, on a real phone.
- **Measure:** APK size, download speed, and whether downloads survive the screen
  turning off.
- **Plan B if Chaquopy fails:** `youtubedl-android` (what Seal uses), porting the
  search and matching logic to Kotlin or TypeScript.
- **Deliverable:** a written decision: Chaquopy, plan B, or drop native Android.

### 2. Deep exploration: connectors and storage (research only, no code) — done

Result in [ADR 0002](adr/0002-user-owned-storage.md): Google Drive preferred,
OneDrive as fallback, Dropbox rejected for now; the library index lives in the
user's storage; the `Storage` port is defined there.

Questions it answered:

- **Providers:** Google Drive, OneDrive, Dropbox, Cloudflare R2 / Backblaze B2,
  WebDAV / Nextcloud. Free quota, API limits and app-registration requirements
  for each (e.g. Dropbox's 500-user development limit; whether Google's
  `drive.file` scope avoids app verification).
- **OAuth with PKCE per platform:** redirect handling in Tauri (loopback) and
  Android (app links / custom scheme); secure token storage (OS keychain,
  Android Keystore).
- **Streaming without downloading:** temporary links, HTTP range requests for
  seeking, Drive via a service worker that adds the auth header.
- **Library index:** where the track list lives when files are in the cloud
  (e.g. an index file inside the user's own storage, which also enables
  multi-device sync).
- **Upload path:** backend or client.
- **Offline cache:** what is kept and when it is evicted.
- **Failure modes:** expired token, quota full, no network.
- **The `Storage` port:** the interface every connector implements.
- **Deliverable:** an ADR with the interface, the first provider and the risks.

### 3. Make the backend embeddable — done

Backend on Starlette, `python -m backend.app` with a free port and a
`SPITIFO_READY` line, per-launch secret, injectable ffmpeg and yt-dlp locations,
retries on transient YouTube errors, `original` without re-encoding and M4A
faststart. The updater that downloads new yt-dlp versions moved to session 9;
only the loading hook (`SPITIFO_YTDLP_DIR`) is done.


- Per-platform library path, free port instead of a hardcoded 8000, injectable
  ffmpeg path.
- yt-dlp updatable without shipping a new app version (YouTube breaks it several
  times a year).
- Health endpoint so the shell knows when the backend is ready.
- Apply whatever session 2 decides about the library.
- From session 1:
  - Port `main.py` from FastAPI to Starlette: pydantic-core has no Android build.
  - Keep the package importable without the HTTP layer.
  - Retry yt-dlp downloads automatically on transient errors such as HTTP 403.
  - Keep YouTube audio unconverted when the format is `original`.
  - Serve correct MIME types without a system MIME database.
- From session 2:
  - Require a random per-launch secret on every backend request: any app on the
    phone can reach `127.0.0.1`.
  - Add `-movflags +faststart` to the M4A encoder so playback starts without
    fetching the end of the file.

### 4. Desktop app (Windows first) — done

Tauri 2 shell in `desktop/`, built with `desktop/build.ps1`. It starts the
PyInstaller backend (one-folder build, so no unpacking on every launch) with a
per-launch secret, waits for `SPITIFO_READY` and points the window at the
backend. A Windows job object kills the backend if the shell dies. The NSIS
installer (per-user, 67 MiB) works on a PC without Python or ffmpeg; the
library goes to `Music\Spitifo`.

- Tauri shell that starts and stops the backend sidecar.
- A `.exe` installer that works on a PC without Python.
- ffmpeg is BtbN's LGPL shared build: ffmpeg and ffprobe load the same DLLs,
  which took the installer from 87 to 67 MiB.
- Left for later: code signing, which belongs with the release work in
  session 9.

### 5. Android app — done

Native WebView shell in `android/` (Kotlin, no Capacitor), built with
`android/build.ps1`. The process starts the unmodified backend with Chaquopy
on a free port with a per-launch secret. A `dataSync` foreground service runs
only while downloads are in flight. The library goes to `Music/Spitifo` and is
added to MediaStore after each batch. YouTube's "Share" menu opens the
search. The signed release APK is 56.9 MB. Findings in the
[ADR 0001 update](adr/0001-android-embedded-python.md#update-2026-10-17-session-5).

- Trimming ffmpeg was dropped: the executables load 70.9 of its 74.5 MB.
- Left for later:
  - A failed search (e.g. no network) shows "nothing found" instead of an
    error.
  - uvicorn's access log writes the per-launch secret to logcat on the
    bootstrap request.
  - The download notification shows no progress.

Planned scope:

- UI in a WebView / Capacitor, backend from session 1.
- Foreground service so downloads continue with the app closed, permission to
  save into the Music folder, signed APK.
- From session 1: start the foreground service per download (without it the
  network is cut when the screen turns off), ship ffmpeg from the
  `youtubedl-android` artifact, and trim its payload to the libraries it loads.
- Share target: Spitifo appears in YouTube's "Share" menu and receives the link.

### 6. `Storage` port and `Local` adapter — done

`backend/app/storage/` holds the port and `LocalStorage`; downloads finish in a
temporary folder and enter the library through `put_file`. The API speaks keys
(`Artist/Artist - Title.mp3`) instead of host paths, and `/api/audio` answers
`Range` with `206`, which the player uses to seek. Contract tests run against
every adapter. Details in the
[ADR 0002 update](adr/0002-user-owned-storage.md#update-2026-10-17-session-6).

- Verified in the browser (playback and seeking) and with the Android build;
  not yet on the phone, which was not connected.

Planned scope:

- Refactor so all file access goes through the port, with no visible change.
- Contract tests against the port that every future connector must pass.
- Keys relative to the library root replace absolute paths in `/api/library` and
  `/api/audio`; `/api/audio` answers range requests itself.

### 7. First connector and the "Connect service" screen

In progress on `feat/cloud-connector`. Done so far: the provider-neutral pieces
in `backend/app/cloud/` (OAuth with PKCE and a loopback receiver, DPAPI token
store, offline audio cache, `index.json` with conditional writes) and the PC
benchmark (`python -m backend.app.cloud.bench`). **Google Drive won**: it met
every target on the PC and on the Pixel over Wi-Fi, 5G and 4G, and the Android
sign-in survives a restart without UI. Numbers in the
[ADR 0002 update](adr/0002-user-owned-storage.md#update-2026-10-17-session-7-google-drive-is-the-first-connector).
The Drive adapter (`backend/app/cloud/drive.py`, one index file per device)
and streaming through `/api/audio` are done and were checked against a real
Drive on the PC: download, upload to `Spitifo/<Artist>/`, play from Drive.
Enabled with `SPITIFO_STORAGE=google` after
`python -m backend.app.cloud.connect google`.
Next: prefetch of the next track, the Android token bridge, and the "Connect
service" screen.

- Starts with a benchmark of Google Drive and OneDrive: time to first audio,
  stalls, seeking, and Android sign-in. Drive is chosen if it meets the targets in
  ADR 0002; otherwise OneDrive.
- Connect, upload, the `index.json` library index, stream through the backend,
  prefetch and offline cache, disconnect.

### 8. Remaining connectors

- One at a time, on the same port and the same contract tests.

### 9. Release and maintenance

- GitHub Actions builds the `.exe` and `.apk` on each tag and publishes them to
  GitHub Releases.
- Not on Google Play: its policy does not allow YouTube downloaders.
- yt-dlp update strategy: download a newer yt-dlp into `SPITIFO_YTDLP_DIR` and
  verify its checksum before loading it (the loading hook exists since session 3).

### 10. Companion player app

- A separate app that plays the library from the user's storage.
- Reuses the OAuth registration of the downloader (both `drive.file` and the
  OneDrive app folder grant access per registered app), the `index.json` format
  and the playback rules in ADR 0002: local first, prefetch the next track,
  stream from the first bytes, range requests for seeking.
- Goal: playback starts in under a second and never stalls.

## Dependencies

```
1 Feasibility ──┬── 3 Embeddable backend ──┬── 4 Desktop
                │                          └── 5 Android
2 Exploration ──┴─────────── 6 Storage port ── 7 First connector ──┬── 8 Others
                                                                    └── 10 Companion app
                                                             9 Release (last)
```

Session 2 does not depend on session 1 and can run in parallel. It comes early
because it decides how the library is stored, which session 3 needs.

## Risks

- **YouTube breaks yt-dlp.** Without in-app updates, every break needs a release.
- **YouTube's bot check.** On 2026-10-16 YouTube answered "Sign in to confirm
  you're not a bot" to every download from the development PC, hours after the
  same downloads worked. yt-dlp's answer is passing the user's browser cookies
  (`--cookies-from-browser`); the apps may need a way to supply them.
- **APK size.** 56.9 MB for the release APK. Accepted, since the APK is not on
  Google Play. Trimming the ffmpeg payload saves only 3.6 MB; an audio-only
  ffmpeg build is what would shrink it.
- **Installer size.** The Windows installer is 67 MiB, and 150 MB of the
  installed 192 MB are ffmpeg's shared libraries, mostly video codecs Spitifo
  never uses. An audio-only ffmpeg build would cut most of that, at the cost of
  compiling and maintaining it.
- **Unsigned binaries.** SmartScreen warns on an unsigned installer until it
  builds reputation.

## Branching

Solo developer, so no long-lived `develop` branch: `main` always works and every
session happens on a short-lived branch.

| Session | Branch | Merge |
| --- | --- | --- |
| 1 Feasibility | `spike/android-chaquopy` | **Never merged.** Only its written decision lands in `main`; the code is rebuilt properly in session 5 |
| 2 Exploration | `docs/storage-exploration` | Merged when the ADR is done |
| 3–8, 10 | `feat/<topic>` (e.g. `feat/embeddable-backend`, `feat/desktop-tauri`, `feat/storage-port`, `feat/connector-onedrive`) | Merged when the session's goal works and the tests pass |
| 9 Release | `ci/release` | Merged; releases are tags on `main` (`v0.1.0`, …) |

Rules:

- One branch per session. If a session grows past a reviewable size, split it
  into chained branches instead of one long-lived branch.
- Rebase or merge `main` into a branch before merging it back, so `main` never
  receives an untested combination.
- Small fixes unrelated to the roadmap can still go straight to `main`.
