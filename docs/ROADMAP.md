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
The "Connect service" dialog (two cards plus the Drive quota bar) signs in
from the UI with no environment variables: OAuth clients come from
`backend/app/cloud/oauth_clients.json` (gitignored) and the choice persists in
`storage.json`. Checked against a real account on the PC.
On Android the host signs in natively: `DriveAuth.kt` gets a `drive.file`
token from `AuthorizationClient` and pushes it into `StaticTokenSource`
(`backend/app/cloud/android.py`), refreshing it silently on start, on resume
and every 50 minutes; no OAuth client file ships in the APK. The library
auto-advances to the next row and prefetches it into the audio cache
(`POST /api/prefetch`). Both were checked on the Pixel against a real Drive:
sign-in from the dialog, a download uploaded from the phone, and the next track
playing from the cache with no request to Drive.
Next: merging the branch. The release build still needs an Android OAuth client
registered for the release signing certificate's SHA-1.

- Starts with a benchmark of Google Drive (OneDrive was the fallback and was
  never needed): time to first audio, stalls, seeking, and Android sign-in.
  Drive met the targets in ADR 0002.
- Connect, upload, the `index.json` library index, stream through the backend,
  prefetch and offline cache, disconnect.

### 8. Remaining connectors

OneDrive was attempted and dropped on 2026-10-18: Microsoft requires an Entra
tenant to register an app for personal accounts, and the maintainer could not
open one (the Azure sign-up was rejected). That attempt still paid off: the
provider-neutral `CloudStorage` base (`backend/app/cloud/base.py`) was extracted
from the Drive adapter, so a future connector only implements the provider hooks
(the file operations, upload, streaming, trash, quota and `describe`) plus its
OAuth provider.

**Google Drive is the only connector for now.** Dropbox and WebDAV remain
options if a second connector is ever needed.

### 9. Release and maintenance — done

[v0.1.0](https://github.com/asormar/spitifo/releases/tag/v0.1.0) was published
on 2026-10-18 from the tag build: the Windows installer, the APK and
`SHA256SUMS.txt`.

- `.github/workflows/release.yml` builds the Windows installer and the release
  APK on each `v*` tag and opens a **draft** GitHub release with both files and
  `SHA256SUMS.txt`; `workflow_dispatch` is a dry run that only uploads
  artifacts. The APK job fails unless the APK is signed with the certificate the
  Android OAuth client is registered for. `.github/workflows/test.yml` runs the
  offline suite and the frontend build on pushes and pull requests.
  `scripts/set_version.py` writes the tag's version into the five files that
  carry it. Secrets and the release steps are in [release.md](release.md).
- The desktop bundle now includes `oauth_clients.json` (it was missing, so Drive
  would have been "not configured" in the installer), and the APK excludes it.
- yt-dlp updates itself: on start, in the background and at most once a day,
  `backend/app/ytdlp_update.py` reads the latest tag from the
  `github.com/yt-dlp/yt-dlp/releases/latest` redirect (the API's 60 requests an
  hour per IP is too tight), downloads the official zipapp, checks it against
  the release's `SHA2-256SUMS` and records it in `current.json` under the data
  dir. The next start loads it, unless the bundled yt-dlp is newer or the zip
  does not import. `SPITIFO_YTDLP_AUTOUPDATE=0` turns it off. The checksum comes
  from the same release, so it guards against corruption, not against a
  compromised GitHub account; yt-dlp's GPG signature is not checked.

- Not on Google Play: its policy does not allow YouTube downloaders.

### 10. Hardening: YouTube's bot check, yt-dlp's signature and cleanup — done

Tackles the open risks that need no new toolchain, before building more on top.

Released as [v0.2.0](https://github.com/asormar/spitifo/releases/tag/v0.2.0). The auto-updater verifies
`SHA2-256SUMS.sig` against yt-dlp's pinned signing key with a pure-stdlib
OpenPGP check; QuickJS-ng 0.17.0 ships in both apps (pinned by SHA-256) and
yt-dlp gets it through `SPITIFO_QJS`, with `android_vr` and `web_embedded` as
fallback clients; an imported `cookies.txt` is used only to retry once when
YouTube shows its bot check. PO-token providers were ruled out: they need
Node 22 and native modules, impossible on Android and about 92 MB on Windows.
Checked on the Pixel with the debug APK: QuickJS runs from the app's native
library directory and a YouTube download completed and uploaded to Drive. The
merged branches and the `android-spike/` build output were deleted.
The v0.2.0 tag build was then checked on both devices: the release-signed APK
signs in to Drive interactively (so the Android OAuth client matches the
release certificate) and downloads from YouTube with QuickJS; the Windows
installer downloads from YouTube, uploads to Drive and streams the result.

- **YouTube's bot check.** Give yt-dlp the user's cookies when YouTube answers
  "Sign in to confirm you're not a bot": decide how each app supplies them
  (`--cookies-from-browser` on Windows; a cookies file or a sign-in WebView on
  Android) and keep them out of logs and of the synced library.
- **yt-dlp's signature.** The auto-updater only checks `SHA2-256SUMS` from the
  same release, which guards against corruption, not against a compromised
  release. Verify yt-dlp's signature over the sums (`SHA2-256SUMS.sig`) with
  its public key pinned in the app before loading a downloaded version.
- **Cleanup.** Delete the merged local branches (`feat/cloud-connector`,
  `refactor/cloud-base`) and decide what to do with the untracked
  `android-spike/` folder.
- Smoke-test the published release on the PC and the Pixel, including Drive
  sign-in from the release-signed APK.

### 11. Smaller and signed binaries — done, except code signing (parked)

- **Audio-only ffmpeg — built and published as `ffmpeg-9.0.2-audio-1`.** `scripts/ffmpeg/build.sh`
  compiles ffmpeg 9.0.2 and LAME 3.100 with `--disable-everything` and an
  allow-list of what Spitifo uses: audio conversion to mp3 and m4a, audio
  extraction, and stream-copy merging of video and audio. The binaries are
  statically linked, about 4 MB each for Windows and Android arm64, with no DLLs.
  `scripts/ffmpeg/smoke.sh` runs the real command lines (the app's and yt-dlp's)
  against small committed samples; it found that the mp4 muxer needs the VP9
  decoder to write a VP9 stream. The `ffmpeg` workflow builds both targets,
  runs the smoke test on Linux and Windows and publishes the zips as a release;
  `scripts/ffmpeg/release.properties` pins the published tag and hashes.
  Measured with the real builds: Windows installer 70.1 MB to 23.1 MB, release
  APK 56.9 MB to 29.5 MB. A full download through the app (mp3, and a VP9 1440p
  plus AAC mp4 merge) worked with the trimmed ffmpeg on Windows and on the
  Pixel. The installer and the APK download the
  published zips, pinned by SHA-256 in `scripts/ffmpeg/release.properties`.
- **Code signing — parked.** SignPath Foundation was the only free option that
  fit (see [code-signing.md](code-signing.md)) and the project applied on
  2026-10-19. It was declined on 2026-10-19: the program wants external signs of
  adoption (stars, forks, contributors, articles, discussions) and the project
  was 18 days old. Releases ship unsigned. The signing steps in the release
  workflow stay in place, gated on `SIGNPATH_ORGANIZATION_ID`, so reapplying
  later (or switching to a paid SignPath plan or a Certum certificate) only
  needs the account, the secret and the variable.

### Three modes: Download, Listen and Discover

Decided on 2026-10-19: instead of a separate companion app, Spitifo becomes one
app with three modes: **Download** (what exists today), **Listen** and
**Discover**. One app keeps a single backend, a single OAuth registration and a
single library. Listen comes first (sessions 12–20), then Discover (21–24).

Each session is small enough for one conversation and ends merged into `main`
with the app still working.

The mode switcher was picked from ten interactive mockups: a bottom tab bar on
phones and an icon rail on the PC, with swipeable pages as an option on phones.

### Speed, motion and size are features

Decided on 2026-10-19: navigation has to feel instant and animated, and the app
must not grow without a reason as features land.

- **Budgets** (session 12 measures the starting point and fixes the numbers):
  time from launch to a usable screen, time to switch modes, time from a tap to
  visible feedback, frame rate while scrolling the library and during
  animations, JavaScript and CSS bundle size, installer size and APK size.
  Starting targets to check against the measurements: a mode switch under
  100 ms, feedback on a tap under 50 ms, 60 frames per second.
- **Guard rails in CI:** the test workflow fails a pull request that pushes the
  frontend bundle over its budget; the release workflow does the same for the
  installer and the APK. Raising a budget is a deliberate, reviewed change.
- **Motion rules:** animate only `transform` and `opacity`, keep interactions
  interruptible, and honour `prefers-reduced-motion`.
- **Recurring reviews:** after every few feature sessions comes a session that
  only removes weight and slowness: sessions 20 and 24 so far, and one more
  after every three or four feature sessions from then on.

### 12. Speed and size baseline — done

Measured on v0.3.0 and written down, with the budgets and how to repeat every
measurement, in [performance.md](performance.md). The size checks run in CI.
What it found, slowest first:

- **The library list is the bottleneck.** `/api/library` reads every file's
  duration on every call, with no cache: 4.2 s for 300 tracks on the Pixel
  (through FUSE) and 0.75 s on the PC. With 300 tracks the drawer takes
  260–400 ms to open and scrolls at 25–50 fps, because every row is rendered
  at once and the drawer animates `grid-template-rows`.
- **Python is not the problem.** The backend is ready 0.44 s after launch on
  the Pixel; on the PC the frozen sidecar needs 1.0 s (yt-dlp is already
  imported lazily). With Drive as the library, the network listing (~2.5 s)
  dominates.
- Taps and in-page mode switches already meet their budgets (13–19 ms).
- Two bugs found on the way: upgrading the Windows app leaves the files of the
  previous release behind (157 MB of old ffmpeg DLLs), and on Android the first
  `/api/library` can answer 503 before the Drive token arrives and is never
  retried.

The plan as written:

- Measure the budgets above on the PC and on the Pixel, with the release
  builds, and write them down in `docs/performance.md` with how to repeat each
  measurement.
- Find where the start-up time goes: the backend's cold start (Chaquopy on
  Android, PyInstaller on Windows), Python imports such as yt-dlp, and the
  first `/api/library`.
- Add the bundle size check to the test workflow and the installer and APK
  checks to the release workflow.
- Measures and adds checks only; the fixes go to the sessions below.

### 13. Split the frontend into modules — done

`main.jsx` is now an entry of 21 lines, and the UI lives in `app/` (the shell:
header, library drawer, settings dialog), `download/`, `player/`, `settings/`
and `shared/`, each with the stylesheets it owns. What changed, measured with
`ui.mjs` on the PC against `main` in the same installed app (medians, 300
tracks):

- **Start-up got faster.** The first script went from 307 KiB to 209 KiB, so
  `/api/library` is requested 87 ms earlier (276 → 188 ms), the first paint
  comes at 444 ms instead of 468 ms and launch to usable is 2.88 s instead of
  2.99 s.
- **The download view, the library and the settings dialog are separate
  chunks.** The download view loads in parallel with the first render; the
  library and settings load when the app is idle, so opening them stays a
  synchronous update in the click, as before.
- **No visible change.** The computed style and position of every element
  match the old build in four states (start, results, library open, settings
  open) on a phone and a desktop viewport, and the stylesheets concatenated in
  import order are byte for byte the old `style.css`.
- Taps, mode switches, the library drawer and its scroll are unchanged (within
  run-to-run noise). All JavaScript together grew 1.0% (chunk overhead), well
  under its budget.
- **On the Pixel, heat outweighed the split.** The build measured second in
  each pair was always slower (thermal throttling), in both orders; with the
  order alternated and the CPU throttled 4× on the PC, the split opened the
  library as fast as before or slightly faster. Details and the method in
  [performance.md](performance.md).

The plan as written:

- `frontend/src/main.jsx` holds the whole UI in 4,376 lines. Split it into
  `shared/`, `download/` and `player/` modules, and `style.css` alongside.
- Each mode becomes its own lazily loaded chunk, so a mode's code is not parsed
  before it is opened.
- No visible change, and no budget from session 12 gets worse.

### 14. A single playback engine — done

`player/engine.js` owns the only `<audio>`, the current track and a queue;
library rows, result previews and the mini-player are views of it
(`useEngine`, a `useSyncExternalStore` hook whose selectors return primitives,
so only the playing row repaints on `timeupdate`). What changed:

- **One `<audio>` instead of one per row.** The element is created on the first
  play, outside the DOM; the library drawer renders no media elements.
- **The queue is the library without videos**, copied when a row starts. Auto
  advance now skips videos instead of stopping on them, and reloading the list
  never interrupts what is playing. A preview is a queue of one.
- **Prefetch moved into the engine** and only fetches the next library track.
  Measured in the browser against the user's Drive library: a prefetched or
  cached track is playing 24–50 ms after the tap; an uncached one took 1.0 s,
  the network time of Drive (unchanged, the backend was not touched).
- **Previous and next** in the mini-player (previous restarts the track after
  3 s). Media Session gained previous, next, ±10 s seeks and the position
  state, so the lock screen and the PC's media keys get the same controls.
- Opening a video pauses the engine and hides the mini-player while the video
  is open, as before.
- One behaviour change: a paused track no longer keeps its position when
  another one starts.
- Frontend unit tests (Vitest, 20 tests of the engine with a fake `Audio`) run
  in the test workflow. All JavaScript is now 2.9% over the session 12
  baseline (1.0% after session 13), within its budget.

The plan as written:

- Today each library row owns its own `<audio>` and auto-advance looks for the
  neighbouring row's element. Replace that with one engine that owns the only
  `<audio>`, the current track and a queue.
- Library rows and the mini-player become views of the engine; prefetch of the
  next track moves into it.
- Keeps the playback rules in ADR 0002: local first, prefetch the next track,
  stream from the first bytes, range requests for seeking. Goal: playback
  starts in under a second and never stalls.
- Media Session API, so the phone's lock screen and the PC's media keys control
  playback.

### 15. App shell: mode switcher and Settings — done

The app now has three modes, Download, Listen and Discover, plus a Settings
screen. What changed:

- **Navigation:** a bottom tab bar under 720 px and an icon rail on the left
  from 720 px. Settings opens from a gear in the phone header and at the
  bottom of the rail. The rail keeps an empty area under the modes for the
  playlists of session 19.
- **Instant switching:** a mode mounts the first time it opens and is then only
  hidden (`hidden` + `inert`), so search results, the library drawer and the
  player survive; each screen keeps its own window scroll position. Every mode
  is its own chunk, and the next likely mode and Settings preload when the app
  is idle. A switch costs under 3 ms of script and layout in the browser.
- **URL and back button:** the mode lives in `?view=` (replaced, so switching
  modes adds no history). Settings pushes one entry, so Android's back button
  closes it; Escape does too. Search keeps using `?mode=` and `?q=`.
- **Settings** replaces the storage dialog: Storage, YouTube cookies and an
  Interface section whose first option switches phones from the tab bar to
  swipeable pages (stored on the device). A swipe never starts in an area with
  its own horizontal gesture (`data-no-swipe`, sliders, the drawer, the
  mini-player, the video).
- The library drawer stays in Download until session 17: its button and the
  mini-player's reveal button switch to Download first. The mini-player stays
  above the tab bar on phones and centred right of the rail on the PC.
- Listen and Discover are empty screens that say what is coming.
- The navigation icons are inline SVGs with the two weights they use: the
  Phosphor components carry all six weights (GearSix alone is 9 KB) and would
  have pushed the first script over its budget. The first script grew from
  221 to 233 KB; all JavaScript is 330.8 KiB of its 332 KiB budget and CSS
  56.3 of 56.6 KiB, so session 16 starts with almost no room.
- Mode switch timing with `ui.mjs` in the installed app is still to be taken.

The plan as written:

- Bottom tab bar on phones, icon rail on the PC; the rail leaves room for
  playlists below the icons. The mini-player stays visible across modes.
- Built for instant switching: a mode stays mounted once opened, so coming back
  keeps its scroll position and data; the next likely mode is preloaded while
  the app is idle.
- A Settings screen that takes in the storage dialog and the YouTube cookies,
  plus an Interface section whose first option switches phones from the tab
  bar to swipeable pages. Swipes must start outside areas with their own
  horizontal gestures, such as the genre map in Discover.
- Listen and Discover start as empty screens.

### 16. Motion system — done

Every animation now comes from one set of tokens, and switching screens
animates. What changed:

- **Tokens** in `shared/tokens.css`: five durations (`--t-press` 120 ms,
  `--t-quick` 180 ms for colour, hover and every exit, `--t-enter` 240 ms,
  `--t-move` 360 ms for indicators and drawers, `--t-scene` 550 ms for the
  theme curtain), three curves (`--ease`, `--ease-io`, which was
  `--ease-drawer`, and `--ease-spring`) and `--stagger` (30 ms). The twenty-odd
  raw durations in the stylesheets now use them; what is left raw is loops,
  waits such as the toast hold and delays under 100 ms.
- **Keyframes:** twenty became eleven. `rise`, `pop` and `leave` take their
  distance or scale from `--rise`, `--pop` and `--leave`, registered with
  `@property` without inheritance so a value set on a container never reaches
  its children.
- **Mode switch:** `app/screenSwap.js` runs every screen change (modes,
  Settings, the back button, swipes) through a View Transition. Only the
  screen moves: it slides 24 px on X from the side of the tab you picked on
  phones and 16 px on Y on the PC rail, while the old one fades out. Settings
  only fades. The header, the tab bar, the rail, the mini-player, toasts and
  the video have their own transition names so they stay on top and live,
  without a ghost of their old position. Each screen keeps its own scroll, so
  the old snapshot is moved by the scroll difference (`--vt-shift`) instead of
  sliding hundreds of pixels. A new switch skips the one running; tapping the
  active mode does nothing. Without the API the new screen fades in; with
  reduced motion it swaps at once.
- The theme curtain now only applies while `data-vt="theme"` is set on
  `<html>`, so mode switches never get it.
- **Rail:** one coral bar that slides to the active mode with the spring, like
  the tab bar pill, instead of a bar per button.
- **Mini-player:** rises 24 px with the spring on `--t-move` and leaves on
  `--t-quick`.
- **Presses:** the buttons that had no press feedback (swipe dots, the
  mini-player title, the resolution menu items, the storage links) scale to
  0.96.
- **Lists:** search results, loading placeholders, library rows, setlist
  tracks and the example searches rise one after another 30 ms apart; only the
  first eight wait.
- **Size:** keyframe consolidation saved 882 B of CSS (659 B net); the View
  Transition rules and `screenSwap.js` still went over, so the budgets went up
  by that much: JS 340,000 → 341,000 B (340,097 B used), CSS 58,000 →
  60,000 B (59,710 B used). Details in `docs/performance.md`.
- Checked in the browser at phone and PC widths: the direction and axis of
  the slide, the header and bars staying above the moving screen, the scroll
  shift, Settings and the back button, the theme curtain, the fallback without
  the API and reduced motion. Still to do on the Pixel: 60 fps during the
  transitions and the Android "Remove animations" setting, plus the `ui.mjs`
  mode-switch timing in the installed app carried over from session 15.

The plan as written:

- Shared motion tokens (durations, easing curves, springs) in the stylesheet,
  used by every animation from here on.
- Transitions between modes, the tab bar and rail indicators, the mini-player
  appearing and disappearing, press feedback on buttons, and list items
  entering.
- The View Transitions API where the WebView supports it, with a plain fade as
  the fallback.
- Checked on the Pixel at 60 frames per second and with reduced motion on.

### 17. Listen: library and queue

- Browse the library by song, artist and album, with search.
- Long lists are virtualised, so a library of thousands of songs scrolls as
  smoothly as one of ten.
- Queue controls: play next, add to the queue, reorder by dragging, remove;
  shuffle and repeat.

### 18. Listen: now playing

- A full-screen "now playing" view that grows out of the mini-player as one
  continuous animation and shrinks back with a swipe down.
- Artwork-tinted background, seek bar with drag, and the queue one swipe away.

### 19. Listen: playlists

- Create, rename, delete and reorder playlists, and add songs from anywhere.
- Playlists live in the user's storage next to `index.json` (local or Drive),
  with conditional writes like the index, so they sync between devices.
- Optimistic updates: the UI changes at once and the write happens in the
  background, undone with a notice if it fails.

### 20. Speed and size review 1

- Measure every budget again and fix whatever regressed since session 12.
- Start-up: whatever session 12 found slowest, such as lazy Python imports or a
  cached first library page shown while the real one loads. Session 12 found
  it: the uncached library listing (see performance.md).
- Size: unused dependencies, fonts and icons; the Python packages that the
  PyInstaller build and the APK carry but never import.

### 21. Discover: research (no code)

- Where genre tags and artist similarity come from, what each source costs and
  whether it works offline.
- What to record about listening (plays, skips, likes) and where it lives.
- How much data the genre map needs on the device, against the size budgets.
- Deliverable: an ADR with the data sources and the recommendation approach.

### 22. Discover: the genre map

- An interactive genre map in the spirit of
  [Every Noise at Once](https://everynoise.com/engenremap.html), with more to
  do on it than browsing: zoom, the user's own genres highlighted, play a
  sample, jump to Download.
- Drawn on a canvas so thousands of genres pan and zoom at 60 frames per
  second.

### 23. Discover: recommendations

- Recommendations from what the user listens to and the artists, songs and
  genres they like, built on session 21's ADR.

### 24. Speed and size review 2

- The same review as session 20, now covering Discover: the map's data and
  rendering, and anything the recommendations added to start-up.

## Dependencies

```
1 Feasibility ──┬── 3 Embeddable backend ──┬── 4 Desktop
                │                          └── 5 Android
2 Exploration ──┴─────────── 6 Storage port ── 7 First connector ──┬── 8 Others
                                                                    └── 19 Playlists
12 Baseline ── 13 Split frontend ── 14 Playback engine ── 15 App shell ── 16 Motion ──┬── 17 Library and queue ── 18 Now playing ── 19 Playlists ── 20 Review 1
                                                                                      └── 21 Discover research ── 22 Genre map ── 23 Recommendations ── 24 Review 2
                                                             9 Release ── 10 Hardening ── 11 Smaller, signed binaries
```

Session 2 does not depend on session 1 and can run in parallel. It comes early
because it decides how the library is stored, which session 3 needs.

## Risks

- **YouTube breaks yt-dlp.** Without in-app updates, every break needs a release.
- **YouTube's bot check.** On 2026-10-16 YouTube answered "Sign in to confirm
  you're not a bot" to every download from the development PC, hours after the
  same downloads worked. yt-dlp's answer is passing the user's browser cookies
  (`--cookies-from-browser`); the apps may need a way to supply them.
- **APK size.** 56.9 MB before session 11; 29.5 MB with the audio-only ffmpeg.
- **Installer size.** 67 MiB before session 11 (150 MB of the 192 MB installed
  were ffmpeg's video codecs); 22 MiB with the audio-only ffmpeg. The cost is
  compiling and maintaining that build: the pinned versions in
  `scripts/ffmpeg/build.sh` need a bump when ffmpeg ships a security fix.
- **Unsigned binaries.** SmartScreen warns on an unsigned installer until it
  builds reputation. SignPath Foundation declined the project for lack of
  visibility; revisit once it has some adoption.

## Branching

Solo developer, so no long-lived `develop` branch: `main` always works and every
session happens on a short-lived branch.

| Session | Branch | Merge |
| --- | --- | --- |
| 1 Feasibility | `spike/android-chaquopy` | **Never merged.** Only its written decision lands in `main`; the code is rebuilt properly in session 5 |
| 2 Exploration | `docs/storage-exploration` | Merged when the ADR is done |
| 3–8, 10–24 | `feat/<topic>` (e.g. `feat/embeddable-backend`, `feat/desktop-tauri`, `feat/storage-port`, `feat/connector-google`) | Merged when the session's goal works and the tests pass |
| 9 Release | `ci/release` | Merged; releases are tags on `main` (`v0.1.0`, …) |

Rules:

- One branch per session. If a session grows past a reviewable size, split it
  into chained branches instead of one long-lived branch.
- Rebase or merge `main` into a branch before merging it back, so `main` never
  receives an untested combination.
- Small fixes unrelated to the roadmap can still go straight to `main`.
