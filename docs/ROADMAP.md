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

One codebase to maintain. The risky part is Android, which is why session 1 is a
feasibility spike.

### Rejected alternatives

- **Central server:** the maintainer would have to run storage and compute for
  everyone, YouTube blocks yt-dlp from datacenter IPs, and a public downloader
  carries legal risk.
- **The user's PC as the server for the phone:** simple, but the phone would only
  work while the PC is on.

## Sessions

### 1. Android feasibility spike (go / no-go)

- **Goal:** a throwaway APK that searches and downloads a song with yt-dlp and
  ffmpeg running inside the app, on a real phone.
- **Measure:** APK size, download speed, and whether downloads survive the screen
  turning off.
- **Plan B if Chaquopy fails:** `youtubedl-android` (what Seal uses), porting the
  search and matching logic to Kotlin or TypeScript.
- **Deliverable:** a written decision: Chaquopy, plan B, or drop native Android.

### 2. Deep exploration: connectors and storage (research only, no code)

Questions to answer:

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

### 3. Make the backend embeddable

- Per-platform library path, free port instead of a hardcoded 8000, injectable
  ffmpeg path.
- yt-dlp updatable without shipping a new app version (YouTube breaks it several
  times a year).
- Health endpoint so the shell knows when the backend is ready.
- Apply whatever session 2 decides about the library.

### 4. Desktop app (Windows first)

- Tauri shell that starts and stops the backend sidecar.
- A `.exe` installer that works on a PC without Python.

### 5. Android app

- UI in a WebView / Capacitor, backend from session 1.
- Foreground service so downloads continue with the app closed, permission to
  save into the Music folder, signed APK.
- Share target: Spitifo appears in YouTube's "Share" menu and receives the link.

### 6. `Storage` port and `Local` adapter

- Refactor so all file access goes through the port, with no visible change.
- Contract tests against the port that every future connector must pass.

### 7. First connector and the "Connect service" screen

- The provider chosen in session 2 (likely OneDrive or Dropbox).
- Connect, upload, stream from the cloud, disconnect.

### 8. Remaining connectors

- One at a time, on the same port and the same contract tests.

### 9. Release and maintenance

- GitHub Actions builds the `.exe` and `.apk` on each tag and publishes them to
  GitHub Releases.
- Not on Google Play: its policy does not allow YouTube downloaders.
- yt-dlp update strategy.

## Dependencies

```
1 Feasibility ──┬── 3 Embeddable backend ──┬── 4 Desktop
                │                          └── 5 Android
2 Exploration ──┴─────────── 6 Storage port ── 7 First connector ── 8 Others
                                                             9 Release (last)
```

Session 2 does not depend on session 1 and can run in parallel. It comes early
because it decides how the library is stored, which session 3 needs.

## Risks

- **Session 1 fails.** That is why it goes first.
- **YouTube breaks yt-dlp.** Without in-app updates, every break needs a release.
- **APK size.** Python + yt-dlp + ffmpeg may exceed 50 MB.

## Branching

Solo developer, so no long-lived `develop` branch: `main` always works and every
session happens on a short-lived branch.

| Session | Branch | Merge |
| --- | --- | --- |
| 1 Feasibility | `spike/android-chaquopy` | **Never merged.** Only its written decision lands in `main`; the code is rebuilt properly in session 5 |
| 2 Exploration | `docs/storage-exploration` | Merged when the ADR is done |
| 3–8 | `feat/<topic>` (e.g. `feat/embeddable-backend`, `feat/desktop-tauri`, `feat/storage-port`, `feat/connector-onedrive`) | Merged when the session's goal works and the tests pass |
| 9 Release | `ci/release` | Merged; releases are tags on `main` (`v0.1.0`, …) |

Rules:

- One branch per session. If a session grows past a reviewable size, split it
  into chained branches instead of one long-lived branch.
- Rebase or merge `main` into a branch before merging it back, so `main` never
  receives an untested combination.
- Small fixes unrelated to the roadmap can still go straight to `main`.
