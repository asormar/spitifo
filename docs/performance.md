# Speed and size

Spitifo treats speed, motion and size as features (see the roadmap, "Speed,
motion and size are features"). This page holds the budgets every session is
checked against, the baseline they were set from, and how to repeat each
measurement. The size budgets are enforced in CI; the speed budgets are checked
by hand in the speed and size reviews (sessions 20 and 24, and every few
feature sessions after that).

Baseline: **v0.3.0** (2026-10-19), the published release builds, measured on
2026-10-19 on the two reference devices below. `main` at the time differed from
v0.3.0 only in documentation. The page timings on the Pixel come from v0.3.0
built with `-Pspitifo.inspectable=true` (the same code, with only the WebView
open to DevTools); everything else comes from the published files.

| Device | Hardware | OS |
| --- | --- | --- |
| PC | AMD Ryzen 5 5600H (6 cores), 15.4 GB RAM, NVMe SSD, 60 Hz screen | Windows 10 Pro 22H2, WebView2 |
| Pixel | Pixel 9 Pro (Tensor G4), 120 Hz screen | Android 16, Android System WebView 155 |

## Budgets

| Budget | Target | Limit | PC (v0.3.0) | Pixel (v0.3.0) | Checked by |
| --- | --- | --- | --- | --- | --- |
| Launch to usable, local library of 300 tracks | 2 s | PC 3.5 s, Pixel 6 s | 3.2 s | 5.4 s | `ui.mjs`, by hand |
| Launch to usable, the user's own setup (Drive, 13 tracks) | 2 s | — (network-bound, for reference) | 5.5 s | 3.7 s | `ui.mjs`, by hand |
| View switch: tap to the first frame of the new view | 100 ms | 100 ms | mode 13 ms ✅, library 400 ms ❌ | mode 19 ms ✅, library 260 ms ❌ | `ui.mjs`, by hand |
| Tap feedback: tap to the first frame that shows it | 50 ms | 50 ms | 16 ms ✅ | 18 ms ✅ | `ui.mjs`, by hand |
| Library scroll, 300 tracks | every refresh (60 Hz PC, 120 Hz Pixel) | 60 fps, under 5% dropped frames | 25–32 fps ❌ | 43–50 fps ❌ | `ui.mjs`, by hand |
| Frames while the library drawer animates, 300 tracks | no frame over 2 refreshes | same | longest 50–67 ms ❌ | longest 125–150 ms ❌ | `ui.mjs`, by hand |
| JavaScript bundle (raw, all `.js`) | — | 340,000 B | 314,126 B (gzip 88,464 B) | same file | CI, `test.yml` |
| CSS bundle (raw, all `.css`) | — | 58,000 B | 52,787 B (gzip 11,115 B) | same file | CI, `test.yml` |
| Windows installer | — | 24,000,000 B | 22,707,225 B | — | CI, `release.yml` |
| Android APK | — | 31,000,000 B | — | 29,451,010 B | CI, `release.yml` |

- **Target** is where the app should be; **limit** is the line no change may
  cross. A row over its limit today (❌) is a known debt with a session that
  owns it (below), not a licence to get worse: until it is fixed, a change must
  not make it slower than the baseline.
- The size limits are the v0.3.0 sizes plus about 5–10%, so a feature has room
  but the room is visible. Raising one is a deliberate change to
  `scripts/perf/budgets.json`, reviewed in its own pull request with the reason
  in the description.
- The speed numbers are medians of several runs (see each section). The PC
  figures were taken with nothing else running: a compile in the background
  made every start-up number about 20% worse.

## Where the start-up time goes

### PC (Windows, PyInstaller sidecar)

Launch to usable is three sequential steps. Medians of 5–7 runs, warm disk cache:

| Step | Local library, 300 tracks | User's setup (Google Drive, 13 tracks) |
| --- | --- | --- |
| Tauri shell starts and spawns the sidecar; sidecar boots until `SPITIFO_READY` | 2.0 s to the app's navigation (sidecar alone: 1.0 s) | 2.4–2.7 s (sidecar alone: 1.7 s) |
| Page load: HTML, the 307 KiB script, first contentful paint | FCP 0.5 s after navigation (DOM ready at 0.2 s) | FCP 0.5–0.95 s |
| First `GET /api/library` answered | 0.8–1.3 s after navigation | 2.4–2.8 s after navigation |
| **Launch to usable** | **3.1–3.3 s** | **5.5 s** |

What the sidecar spends its 1.0 s on (`python -X importtime`, and timing the
lifespan step by step in the same interpreter):

- **Importing `backend.app.main`: about 1.0 s frozen (1.3 s from the venv).**
  The biggest pieces are `asyncio` with the standard library it pulls in
  (logging, concurrent.futures, ssl, socket: ~0.47 s), Starlette (~0.28 s) and
  httpx, which `ytdlp_update` imports at module level (~0.22 s).
- **yt-dlp is not imported at start-up.** `sources` registers it lazily and
  `runtime.bundled_ytdlp_version()` reads its version without importing it. It
  is only imported early when a downloaded yt-dlp zip is newer than the bundled
  one (`runtime._insert_zip`).
- **With Google Drive as the library, building `DriveStorage` in the lifespan
  adds 0.2–0.7 s before `SPITIFO_READY`** (token store, HTTP client, TLS
  context), and the first `/api/library` lists the Drive folder over the
  network (2.4 s for 13 tracks). The second call is served from the cache in
  4 ms.
- **A local `/api/library` is not cached: 300 tracks take 0.7–0.8 s on every
  call** (about 2.5 ms per file, reading each file's duration), and 6 s on the
  first call after the files were written (Windows Defender scans them).
- The very first launch after installing took 1.9 s to `SPITIFO_READY` instead
  of 1.0 s, and 0.8 s for the first `GET /`: the antivirus scans the unpacked
  runtime once.

### Pixel (Android, Chaquopy)

The phone starts the backend much faster than the PC: Chaquopy's interpreter
and the app's bytecode are already unpacked after the first launch, and there
is no antivirus in the way. Medians of 5 cold starts (`am force-stop`, then
`am start`), times from the launch as logged by `ActivityTaskManager`:

| Done at (time since launch) | Local library, 302 tracks | User's setup (Google Drive, 13 tracks) |
| --- | --- | --- |
| First frame of the Activity (the "Starting…" text) | 0.13 s | 0.09 s |
| `Backend.setUp`: frontend check, ffmpeg symlinks and probe, `Python.start` | 0.24 s | 0.22 s |
| `import backend.app.main` (0.17 s of its own) | 0.42 s | 0.39 s |
| Lifespan, `backend ready` | 0.44 s | 0.44 s |
| WebView created, `GET /` answered | 0.53 s | 0.59 s |
| First `GET /api/library` answered | **4.7–4.9 s** | **3.4–3.9 s** |
| **Launch to usable** (`ui.mjs`) | **4.8–5.8 s** | **3.7 s** |

- **Everything before the library takes half a second.** Python, the imports
  and uvicorn are not where the time goes on the phone.
- **The local library is the slowest step: 4.2 s for 302 files**, about 14 ms
  per file, because every request walks the public Music folder through FUSE
  and reads every file's duration, with no cache.
- **With Drive, the library waits for the network** (~2.8 s to list the folder)
  and for Kotlin to hand Python a fresh Google token (`DriveAuth` refreshes it
  silently about 0.6 s after launch).
- Found while measuring: **in one of five launches `/api/library` answered 503**
  because the page asked before that token had arrived (request at 0.8 s, token
  at 1.06 s), and the page did not ask again within the next 10 s, so the
  library stayed unloaded.

## What makes the library slow

With 300 tracks the library drawer takes 400 ms to show its first frame on the
PC (1.1–1.2 s the first time it opens), 700 ms to settle instead of the 280 ms
its transition lasts, and scrolls at 25–32 fps. On the Pixel: 260 ms (0.6–0.7 s
the first time), 470 ms to settle, frames of up to 150 ms while it animates,
and 43–50 fps on a 120 Hz screen. With 13 tracks the same drawer opens in
20 ms on the PC and 49 ms on the Pixel and scrolls at full refresh rate (60 and
119 fps), so the cost grows with the list.
Likely causes, for session 13 (the split, with each mode lazily loaded) and
session 20 (the first review) to confirm with a profile:

- every track is rendered at once (no virtualisation), and each row is a full
  `Player` with its own `<audio>` element and state;
- the drawer animates `grid-template-rows`, which lays out the whole list on
  every frame; the motion rules allow only `transform` and `opacity`;
- every `Player` subscribes to the shared player state (`watchers`), so one
  change can re-render every row.

## Size

### Frontend bundle

`npm run build` in `frontend/` writes one script and one stylesheet (Vite, no
code splitting yet):

| File | Raw | gzip -9 |
| --- | --- | --- |
| `index-*.js` (React, Phosphor icons, the whole UI in `main.jsx`) | 314,126 B | 88,464 B |
| `index-*.css` | 52,787 B | 11,115 B |
| Fonts (Figtree and Outfit, latin and latin-ext woff2) | 77,548 B | — |

The limits count raw bytes: everything runs from disk, so what costs time is
what the WebView parses, not what crosses a network.

### Windows installer: 22,707,225 B

Installed, the app takes about 52 MB:

| Part | Installed size |
| --- | --- |
| `backend/` (PyInstaller one-folder sidecar) | 35.4 MB: `spitifo-backend.exe` 12.4 MB (the PYZ with yt-dlp and the app) and `_internal/` 23.0 MB (python312.dll 6.9 MB, libcrypto 5.2 MB, sqlite3 1.6 MB, ucrtbase 1.4 MB, base_library.zip 1.3 MB, unicodedata 1.1 MB, libssl 0.8 MB, watchfiles 0.6 MB, …) |
| `ffmpeg/` (audio-only ffmpeg and ffprobe) | 8.3 MB |
| `spitifo.exe` (Tauri shell) | 5.8 MB |
| `qjs/` (QuickJS-ng) | 2.2 MB |
| `frontend/` | 0.45 MB |

Found while measuring: **upgrading over 0.2.0 leaves the old files behind.**
The install folder still held the shared-library ffmpeg of 0.2.0 (avcodec,
avfilter, avformat and four more DLLs, 157 MB) and the previous frontend's
script and stylesheet next to the new ones. The installer copies its files but
never removes the ones a release dropped.

### Android APK: 29,451,010 B

Compressed sizes inside the APK:

| Part | In the APK |
| --- | --- |
| Python packages (`requirements-common.imy`: yt-dlp, Starlette, uvicorn, httpx, …) | 7.5 MB (stored) |
| Python standard library (`stdlib-*.imy`) | 5.8 MB (stored) |
| `classes.dex` (Kotlin, Chaquopy's Java side; `isMinifyEnabled = false`) | 5.6 MB (stored) |
| libpython3.12 | 1.8 MB |
| ffmpeg and ffprobe | 1.7 + 1.6 MB |
| Chaquopy bootstrap and native modules | 1.6 MB |
| OpenSSL (libcrypto, libssl) | 1.7 MB |
| QuickJS-ng | 1.1 MB |
| SQLite | 0.5 MB |
| Frontend | 0.2 MB |

## How to measure

Everything below lives in `scripts/perf/`. Measure the **release** builds:
download the release's installer and APK (`gh release download vX.Y.Z`), or
build them as `release.yml` does. Close everything else first.

### Sizes

```bash
node scripts/perf/check_size.mjs bundle frontend/dist
node scripts/perf/check_size.mjs installer Spitifo-X.Y.Z-windows-x64-setup.exe
node scripts/perf/check_size.mjs apk Spitifo-X.Y.Z-android-arm64.apk
```

The same commands run in CI: the bundle check in the `frontend` job of
`test.yml` (every pull request), the installer and APK checks in the `windows`
and `android` jobs of `release.yml`. Each one prints a table to the job summary
and fails the job when a size is over its limit in `scripts/perf/budgets.json`.

### A library to measure with

The speed budgets are defined on a library of 300 tracks:

```bash
python scripts/perf/seed_library.py <library folder> --count 300
python scripts/perf/seed_library.py <library folder> --remove
```

It writes 300 copies of a 3-second MP3 into `Perf Artist NN` folders and
`--remove` deletes exactly those folders. On the PC the library folder is
`%USERPROFILE%\Music\Spitifo`; on the phone, push the folders to
`/sdcard/Music/Spitifo/` with `adb push`.

### Backend start-up (PC)

```bash
python scripts/perf/backend_start.py --exe "$LOCALAPPDATA/Spitifo/backend/spitifo-backend.exe" \
    --library <folder> --data-dir <empty folder> --runs 7
```

It starts the installed sidecar exactly as the shell does and prints, per run
and as medians, the time to `SPITIFO_READY`, the first `GET /` and the first
and second `GET /api/library`. Leave out `--data-dir` to use the real settings
(and so the user's real storage, Drive included). `--python
.venv/Scripts/python.exe` runs the checkout instead of the installed app. For
the import breakdown:

```bash
python -X importtime -c "import backend.app.main" 2> importtime.txt
```

(with `SPITIFO_DATA_DIR` and `SPITIFO_LIBRARY` set; the frozen sidecar ignores
`PYTHONPROFILEIMPORTTIME`, so this runs from the venv).

### UI on the PC

```bash
SPITIFO_DATA_DIR=<empty folder> node scripts/perf/ui.mjs --launch "$LOCALAPPDATA/Spitifo/spitifo.exe" --runs 8
```

`ui.mjs` launches the installed app with WebView2's DevTools port open
(`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`),
attaches to the page and reports:

- **startup**: launch to the app's navigation, first contentful paint, when
  `/api/library` answered and launch to usable (the later of the two);
- **tapFeedback**: `pointerdown` on a format chip to the end of the next frame;
- **modeSwitch**: a click on a search mode to the end of the next frame;
- **libraryOpen / libraryClose**: the same for the library button, plus the
  time until the drawer's transition ends and the longest frame during it;
- **libraryScroll**: three flings down and up the open library, with the frame
  rate, the median and 95th percentile frame interval and the share of frames
  that took over 1.5 refreshes.

Run it three times and keep the medians. The timings start at the input
event's timestamp inside the page, so they leave out the operating system's
input latency and the display's scan-out (up to one more refresh); compare
them with each other, not with a camera.

Setting `SPITIFO_DATA_DIR` to an empty folder makes the app use the local
library with default settings without touching the user's own; leave it out to
measure the real setup.

### UI and start-up on the Pixel

The release WebView cannot be inspected, so build the release APK with one
extra property (same code, same signing, only `WebView.setWebContentsDebuggingEnabled`
switched on):

```bash
cd android && ./gradlew assembleRelease -Pspitifo.inspectable=true
adb install -r app/build/outputs/apk/release/app-release.apk
```

Then, with the screen unlocked and the library seeded:

```bash
node scripts/perf/ui.mjs --adb "$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" --runs 8
```

`--adb` force-stops and starts `dev.spitifo`, reads the launch time from
logcat (`ActivityTaskManager`'s `START` line, on the same clock as the page's
`performance.timeOrigin`), forwards `webview_devtools_remote_<pid>` to port
9333 and sends touch input. Keep the phone unlocked and untouched while it
runs: a WebView whose Activity is not in front stops producing frames and the
run hangs. In Git Bash, set `MSYS_NO_PATHCONV=1` before any `adb` command that
names a path on the phone, or Bash rewrites `/sdcard/...` into a Windows path.

For the backend's own steps, start the app with logcat cleared and read the
`Spitifo` and `python.stderr` lines (`setup=… ms`, `backend imported in`,
`backend ready on port`, the access log of `GET /api/library`):

```bash
adb shell am force-stop dev.spitifo && adb logcat -c
adb shell am start -W -n dev.spitifo/.MainActivity
adb logcat -d -v epoch | grep -E "START u0|Spitifo|python.stderr"
```

To measure the local library when the phone uses Drive, switch the storage to
local from Settings (or `POST /api/storage/use {"provider": "local"}` from the
page) and back to Google Drive afterwards; Drive stays connected, so switching
back needs no sign-in.

Reinstall the published APK afterwards so the phone is not left with an
inspectable build.
