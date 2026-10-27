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
| JavaScript bundle (raw, all `.js`) | — | 341,000 B | 314,126 B (gzip 88,464 B) | same file | CI, `test.yml` |
| CSS bundle (raw, all `.css`) | — | 60,000 B | 52,787 B (gzip 11,115 B) | same file | CI, `test.yml` |
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
  library stayed unloaded. Fixed: a request that finds no token yet now waits
  up to 5 s for it (`STARTUP_TOKEN_WAIT_S` in `backend/app/cloud/android.py`).

## What makes the library slow

> **Session 20:** fixed on disk. Durations and tags are cached in
> `.spitifo/media-cache.json` (keyed by path, size and mtime) and the folder is
> walked with `os.scandir`, resolving only symlinks. 300 tracks on the PC,
> median of 5 launches of `backend_start.py`: `library1_ms` 342 → 36 ms. The
> numbers below are from before the fix.

With 300 tracks the library drawer takes 400 ms to show its first frame on the
PC (1.1–1.2 s the first time it opens), 700 ms to settle instead of the 280 ms
its transition lasts, and scrolls at 25–32 fps. On the Pixel: 260 ms (0.6–0.7 s
the first time), 470 ms to settle, frames of up to 150 ms while it animates,
and 43–50 fps on a 120 Hz screen. With 13 tracks the same drawer opens in
20 ms on the PC and 49 ms on the Pixel and scrolls at full refresh rate (60 and
119 fps), so the cost grows with the list.
Likely causes, for session 20 (the first review) to confirm with a profile
(the split in session 13 moved this code without changing it, and the drawer
measured the same before and after):

- every track is rendered at once (no virtualisation), and each row is a full
  `Player` with its own `<audio>` element and state;
- the drawer animates `grid-template-rows`, which lays out the whole list on
  every frame; the motion rules allow only `transform` and `opacity`;
- every `Player` subscribes to the shared player state (`watchers`), so one
  change can re-render every row.

## Size

### Frontend bundle

`npm run build` in `frontend/` wrote one script and one stylesheet at v0.3.0
(Vite, no code splitting):

| File | Raw | gzip -9 |
| --- | --- | --- |
| `index-*.js` (React, Phosphor icons, the whole UI in `main.jsx`) | 314,126 B | 88,464 B |
| `index-*.css` | 52,787 B | 11,115 B |
| Fonts (Figtree and Outfit, latin and latin-ext woff2) | 77,548 B | — |

Since session 13 the UI is split into modules and the build writes one script
per lazily loaded part. Only the entry is in `index.html`; the download view is
requested while the first render runs, and the library and the settings dialog
when the app is idle:

| File | Raw | gzip -9 |
| --- | --- | --- |
| `index-*.js` (React, Phosphor icons, the shell, the player engine, mini-player and video host) | 214,071 B | 64,421 B |
| `DownloadView-*.js` (search, result cards, downloads) | 65,345 B | 17,925 B |
| `StorageDialog-*.js` (storage dialog, YouTube cookies) | 20,704 B | 5,918 B |
| `Library-*.js` (library drawer) | 8,691 B | 2,766 B |
| `Player-*.js` (shared by the results and the library) | 4,892 B | 1,995 B |
| `GoogleDriveLogo.es-*.js` (an icon both lazy parts use) | 3,576 B | 1,327 B |
| **All scripts** | **317,279 B** (+1.0%, chunk overhead) | 94,352 B |
| `index-*.css` (unchanged: every stylesheet is imported by the entry, in the old order) | 52,787 B | 11,115 B |

With the smaller first script, the PC starts faster: on the same installed
app with 300 tracks, `/api/library` is requested at 188 ms instead of 276 ms,
first contentful paint is at 444 ms instead of 468 ms and launch to usable
takes 2.88 s instead of 2.99 s (medians of `ui.mjs` runs: three of the split
build and two of `main`, leaving out its first run, which read the freshly
seeded files while the antivirus scanned them; both builds were swapped into
the same install). Taps, mode switches and the library drawer did not change.

On the Pixel (302 local tracks, release APKs built with
`-Pspitifo.inspectable=true` from `main` before and after the split, installed
over each other) heat decided the numbers, not the split: the phone reached
thermal status 1 within the first pair of runs, and the build measured second
in a pair was always the slower one. With the old build first, the split took
about 90 ms longer to show the library (320 → 414, 879 → 975 and 808 → 894 ms);
with the split first, the old build took 358 ms longer (397 → 755 ms) and
scrolled slower (27 → 20 fps). To take heat out of it, the same comparison ran
on the PC with the CPU throttled 4× through DevTools and the order alternated
(A B B A A B): the split opened the library in 752 ms against 777 ms, settled
in 1,123 against 1,186 ms and scrolled at 12.2 against 11.8 fps. No budget got
worse.

Lessons for the next comparison on the phone: alternate the order, let it cool
to thermal status 0 before each run (`adb shell dumpsys thermalservice`), and
keep in mind that charging over USB keeps the battery around 38 °C. A build
made from the checkout needs `versionCode` raised to the installed one (300 for
0.3.0, see `scripts/set_version.py`) or `adb install -r` refuses it as a
downgrade; never uninstall instead, it wipes the app's data.

The limits count raw bytes: everything runs from disk, so what costs time is
what the WebView parses, not what crosses a network.

The first raise came with the motion system (session 16). Session 15 had left
1.2 KiB of script and 0.3 KiB of stylesheet. The motion system first paid for
itself where it could: twenty keyframes became eleven (`rise`, `pop` and
`leave` take their distance or scale from a variable), 1,727 B down to 845 B,
of which 223 B went back to registering those variables. What was still over
is the price of the feature: the View Transition rules for the mode switch
(about 1 KB of CSS) and the code that runs it (about 1.3 KB of JS). The
limits went up by just that, rounded to the next thousand bytes:

| Bundle | `main` before | Session 16 | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 338,767 B | 340,097 B (+1,330) | 340,000 B | 341,000 B |
| CSS | 57,677 B | 59,710 B (+2,033) | 58,000 B | 60,000 B |

The second raise came with Listen (session 17). Removing the library drawer
paid for part of it, and the first script shrank from 233 to 231 KB, but the
screen itself (tabs, search, virtual lists, the editable queue) is a new 22 KB
lazy chunk. Its icons are inline paths, not Phosphor components, which saved
about 18 KB:

| Bundle | `main` before | Session 17 | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 340,097 B | 349,122 B (+9,025) | 341,000 B | 350,000 B |
| CSS | 59,710 B | 60,665 B (+955) | 60,000 B | 61,000 B |

The third came with "Ahora suena" (session 18). The view and its stylesheet are
a lazy chunk preloaded when the app is idle, so the first stylesheet did not
grow and the first script grew 2.2 KB:

| Bundle | Before | Session 18 | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 349,122 B | 360,473 B (+11,351) | 350,000 B | 361,000 B |
| CSS | 60,665 B | 65,818 B (+5,153) | 61,000 B | 66,000 B |

The fourth came with playlists (session 19); the first script grew 0.7 KB and
the rest is in Listen's lazy chunks:

| Bundle | Before | Session 19 | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 360,473 B | 373,444 B (+12,971) | 361,000 B | 374,000 B |
| CSS | 65,818 B | 69,066 B (+3,248) | 66,000 B | 70,000 B |

Session 20 (the first speed and size review) starts from here: Listen, "Ahora
suena" and playlists added 31 KB of JavaScript and 9 KB of CSS over sessions
17–19, nearly all of it in lazy chunks.

Session 20 then removed the Phosphor components (each one carries all six
weights) in favour of inline paths: all JavaScript 373,651 → 288,038 B, the
first script 234,248 → 191,235 B. The JavaScript limit went **down** to
295,000 B; CSS was unchanged (69,066 B of 70,000 B).

The Listen home (search with grouped results, the home sections, the pages
and their history stack) raised both limits. Almost all of it is the lazy
Listen chunk (11.9 → 32.8 KB of script, a 16.0 KB stylesheet loaded with it);
the first script grew 0.8 KB (the history tracker and `play(track, {at})`) and
the first stylesheet shrank 1.3 KB (the old tabs and search bar). The queue
code now only loads with "Ahora suena":

| Bundle | Before | Listen home | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | about 294,600 B | 316,058 B (+21,400) | 295,000 B | 317,000 B |
| CSS | about 70,750 B | 85,232 B (+14,500) | 71,000 B | 86,000 B |

The genre map (session 22) is a lazy Discover chunk; its data file
(`genre-map.json`, 89 KB gzip) is fetched when Discover opens and is not part
of these bundles:

| Bundle | `main` before | Session 22 | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 316,465 B | 337,786 B (+21,321) | 317,000 B | 339,000 B |
| CSS | 85,232 B | 91,766 B (+6,534) | 86,000 B | 93,000 B |

Recommendations (session 23) live in the same lazy Discover chunk, which grew
from 21.3 to 48.4 KB of script and from 6.5 to 18.0 KB of CSS: the "Para ti"
sheet and panel, their pointer gestures, the store and the camera's obstacle
for the panel. The first script and stylesheet did not grow. Session 24 should
look at trimming this chunk first:

| Bundle | `main` before | Session 23 | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 337,786 B | 366,005 B (+28,219) | 339,000 B | 367,000 B |
| CSS | 91,766 B | 103,358 B (+11,592) | 93,000 B | 104,000 B |

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
