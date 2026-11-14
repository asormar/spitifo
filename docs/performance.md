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

| Budget | Target | Limit | PC (v0.3.0) | Pixel (v0.3.0) | PC (session 24) | Checked by |
| --- | --- | --- | --- | --- | --- | --- |
| Launch to usable, local library of 300 tracks | 2 s | PC 3.5 s, Pixel 6 s | 3.2 s | 5.4 s | 1.15–1.3 s ✅ | `ui.mjs`, by hand |
| Launch to usable, the user's own setup (Drive, 13 tracks) | 2 s | — (network-bound, for reference) | 5.5 s | 3.7 s | 1.7–1.8 s ✅ | `ui.mjs`, by hand |
| View switch: tap to the first frame of the new view | 100 ms | 100 ms | mode 13 ms ✅, library 400 ms ❌ | mode 19 ms ✅, library 260 ms ❌ | mode 16–19 ms ✅, content 34–37 ms | `ui.mjs`, by hand |
| First visit to Descubrir: tap to the map's first drawn frame | 100 ms | 100 ms | — | — | 44–57 ms ✅ | `ui.mjs`, by hand |
| Tap feedback: tap to the first frame that shows it | 50 ms | 50 ms | 16 ms ✅ | 18 ms ✅ | 16 ms ✅ | `ui.mjs`, by hand |
| Library scroll, 300 tracks | every refresh (60 Hz PC, 120 Hz Pixel) | 60 fps, under 5% dropped frames | 25–32 fps ❌ | 43–50 fps ❌ | 60 fps, 0% ✅ | `ui.mjs`, by hand |
| Frames while the library drawer animates, 300 tracks | no frame over 2 refreshes | same | longest 50–67 ms ❌ | longest 125–150 ms ❌ | no drawer since session 17 | `ui.mjs`, by hand |
| Frames while the map pans and zooms, and "Para ti" opens and closes | no frame over 2 refreshes | same | — | — | 60 fps, longest 17–33 ms ✅ | `ui.mjs`, by hand |
| JavaScript bundle (raw, all `.js`) | — | 402,350 B | 314,126 B (gzip 88,464 B) | same file | 369,716 B | CI, `test.yml` |
| CSS bundle (raw, all `.css`) | — | 108,400 B | 52,787 B (gzip 11,115 B) | same file | 102,395 B | CI, `test.yml` |
| Windows installer | — | 24,000,000 B | 22,707,225 B | — | 19,952,579 B (local build) | CI, `release.yml` |
| Android APK | — | 31,000,000 B | — | 29,451,010 B | — | CI, `release.yml` |

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
- **Session 24** measured a local 0.6.1 build of the session's branch, installed
  on the PC, with a downloaded yt-dlp update present (as on any installation
  after its first update). The ranges leave out the first launch of each set,
  which builds the media cache or follows the install's antivirus scan
  (3.1–3.8 s). Same day, same conditions, an empty library: 0.6.0 and 0.6.1
  both reached usable in 1.1–1.25 s, so the start-up gain over 0.6.0 is the
  yt-dlp import and the Drive reads below, not noise. The Pixel was not
  measured again.

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
  `runtime.bundled_ytdlp_version()` reads its version without importing it.
  Until session 24 it was imported early when a downloaded yt-dlp zip was newer
  than the bundled one (`runtime._insert_zip` tried the import to fall back if
  it failed), which is every installation after its first yt-dlp update:
  importing from the zip takes about 1.1 s on the PC (zipimport compiles every
  `.py` again on each launch; the same files extracted to a folder import in
  0.7 s once their `.pyc` are written). The zip now goes on `sys.path` without
  being imported, and `runtime.verify_ytdlp_zip` tries the import in a thread
  once the server is up (a zip that fails is dropped as before). With the
  update present, launch to the app's navigation went from 1.55–2.13 s to
  0.85–0.93 s.
- **After session 24: the yt-dlp update is imported from a folder.** Once
  `verify_ytdlp_zip` has imported the zip, it extracts it to
  `yt-dlp-<version>/` next to it and compiles the modules that import loaded
  (69 of the zip's 1,046 `.py`; compiling all of them takes 15 s), and every
  later launch puts that folder on `sys.path` instead of the zip. A marker
  file with the zip's SHA-256 is written last, so a cut extraction is ignored;
  a folder that fails to import is deleted and the next launch goes back to
  the zip. The `.pyc` are written by the extraction because the frozen app may
  not write bytecode. The import, from the venv with `python -B` on the PC,
  5 runs: zip 0.79–0.91 s, folder 0.43–0.47 s. The extraction is a one-off
  1.0–1.7 s in the background, on the launch after each update. Modules
  imported later (YouTube's extractor, at the first search) are not
  precompiled, and still import faster from the folder than from the zip
  (0.82 s against 1.0 s for the whole package without `.pyc`).
- **With Google Drive as the library, building `DriveStorage` in the lifespan
  adds 0.2–0.7 s before `SPITIFO_READY`** (token store, HTTP client, TLS
  context), and the first `/api/library` lists the Drive folder over the
  network (2.4 s for 13 tracks). The second call is served from the cache in
  4 ms.
- **Session 24: Drive's start-up reads.** They were sequential: resolve the
  `Spitifo` folder by name, list the `index-*` files, download each one. Now
  the small library files (`index-*`, `playlists-*`, `listens-*`, …) keep a
  local copy in `<data dir>/snapshots/` (`backend/app/cloud/snapshot.py`),
  keyed by the version Drive reports and checked with SHA-256 on every read,
  so a launch lists the folder once and downloads only what changed, up to
  four files at a time; the folder ids are remembered too. The copy is never a
  source of truth: anything unreadable is fetched again. `/api/library` on the
  owner's Drive: 3.4 s → 0.5 s, launch to usable 5.3 s → 1.7–1.8 s.
- **Session 24: `/api/discover` never waits for a refresh.** Its inputs are
  cached for 30 s; an expired value is now returned at once and refreshed in a
  background thread (stale-while-revalidate), so only the first request after
  a launch waits for Drive: 3.8 s → 1.2–2.2 s on the owner's setup, every
  later one 5–7 ms. It still lists Drive five times in a row (the listens are
  listed twice), which is the next thing to cut there.
- **After session 24: the first `/api/discover` lists Drive in parallel.** Its
  four inputs (library, artist records, dismissals, listens) are loaded at the
  same time, the monthly and aggregate listens files come from one `files.list`
  (`(name contains 'listens-' or name contains 'listenagg-')`, following
  `nextPageToken`, which no listing did before), and a folder id already
  resolved is read without the adapter lock, which `_load_index` holds while it
  lists. The enricher that starts after the request reuses its fresh inputs
  instead of listing them again. On the owner's Drive, installed 0.6.1 with
  only the sidecar swapped, 4 launches each: the cold request 1.17–1.32 s →
  0.42–0.63 s, its listings 4 sequential → 3 parallel, and Drive listings per
  launch (library, Discover, enricher, listen history) 12 → 6.
  `tests/test_discover_drive.py` counts them on the fake Drive. The 4.4 s gap
  once seen before an `alt=media` download did not come back (no downloads in
  8 launches): httpx logs a request when its response headers arrive, so that
  gap was Drive's own time to answer the download, not work in the app.
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

Session 24 split "Para ti" out of the Discover chunk, so the first visit to
Descubrir downloads 32.3 KB of script and 8.2 KB of CSS instead of 48.4 and
18.0 KB; "Para ti" (19.2 KB and 8.8 KB) loads next to the map's data, and its
panel shows a static frame (`ForYouSlot`) until it arrives. The split costs
3.7 KB of script in total (the static frame, the panel measurements both chunks
share in `frame.js`, and the chunk's own wrapper); the CSS came out 1 KB
smaller:

| Bundle | `main` before | Session 24 | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 366,005 B | 369,716 B (+3,711) | 367,000 B | 371,000 B |
| CSS | 103,358 B | 102,395 B (−963) | 104,000 B | 103,000 B |

The redesign's navigation shell (four tabs with one page stack, the phone tab
bar and floating mini-player, and on a desktop the left nav, top bar and
floating player bar) replaces the old header pill, theme switch and icon rail,
and adds the stores that let the shell outlive a screen (downloads, search text,
theme) and the pure navigation helpers. Net of the deletions (and of its size,
performance and motion review) it adds 4,617 B of
script and 166 B of style; only the script needed a new limit:

| Bundle | Before the shell | After | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 370,415 B | 375,032 B (+4,617) | 371,000 B | 376,500 B |
| CSS | 98,055 B | 98,221 B (+166) | 103,000 B | 103,000 B |

The unified Buscar (one search field, library hits as you type, result rows
that become a table on a desktop, truthful verdict pills, the download ring, the
result ficha and the resolution menu as sheets on the navigation stack) replaces
the old cards, controls, status chip, per-card preview player and verify panel.
Net of the deletions (and of its size, performance and motion review) it adds
1,643 B of script and 1,014 B of style; only the script needed a new limit.
Buscar's stylesheets and the storage section's (now loaded with Ajustes) also
left the render-blocking first stylesheet: it went from 59,397 B to 40,678 B,
and the lazy Buscar chunk now carries 18,957 B of style and 34,766 B of script:

| Bundle | Before Buscar | After | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 375,032 B | 376,675 B (+1,643) | 376,500 B | 377,700 B |
| CSS | 98,221 B | 99,235 B (+1,014) | 103,000 B | 103,000 B |

The redesigned Inicio and Tu biblioteca (the Mezcla record with endless mixes,
shelves and card grids that load in steps, the Todas tus canciones page with a
table on a desktop, grouped library search with a best-result card, and covers on
the song rows) replace the old feed, the full-library root and the group rows.
Net of the deletions (and of its size, performance and motion review) it adds
4,724 B of script and 1,021 B of style; only the script needed a new limit. The
stacked pages (`Pages.jsx`, `pages.css`) are now their own lazy chunk, preloaded
when the app is idle, so Inicio's stylesheet went from 14,123 B to 11,394 B (plus
893 B of chips shared with Buscar) and the pages chunk carries 11,625 B of script
and 4,165 B of style; the render-blocking first stylesheet is 40,223 B. Rows with
a cover (only videos have one in a real library; the test library gives 100 of
341 tracks one, 480x360, 19 KB) cost frames on a fast scroll: at 4x CPU
throttling 1.5–4.4% of the frames of a 2,900 px/s scroll took two refreshes
(one first pass took 83 ms) against none with the images hidden, and none at 1x.
`/api/audio` now sends `Cache-Control: private, max-age=604800` for the `.jpg`
so a row that mounts again does not ask for it again; the real fix for covers is
a ~100 px thumbnail from the backend:

| Bundle | Before Inicio and Tu biblioteca | After | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 376,675 B | 381,399 B (+4,724) | 377,700 B | 381,850 B |
| CSS | 99,235 B | 100,256 B (+1,021) | 103,000 B | 103,000 B |

The review of that change measured two things on 3,000 rows with a cover on
every row, at 6x CPU throttling on a desktop viewport. Todas tus canciones
dropped 5–16% of its frames in a 2,900 px/s scroll: every mounted row rendered
again on each row crossing (the play callback was a new function each time, so
nothing could be memoized) and each cover that landed repainted the list. Rows
are now `memo`ized with stable props, and while the list moves faster than
2 px/ms (taken over 60 ms, so a 100 px wheel notch cannot reach it) the covers
are not painted until 140 ms after it slows: 0.3–2.4% dropped, against 0–0.3%
with no covers at all and 0% on the phone at 4x. Opening a page before its chunk
had loaded left 6–8 blank frames on a desktop; it now waits for the chunk with
the screen still showing (0 frames).
The second lever was the minifier: terser (`build.minify`, two passes) gives
5,304 B less than esbuild on the same code, 4,883 B from terser itself and 421 B
from the second pass, for about 2 s more of build time. The JavaScript limit
now has 518 B of headroom instead of 451 B, with the review fixes (+287 B)
included:

| Bundle | After Inicio and Tu biblioteca | After the review | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 381,399 B | 376,382 B (−5,017: +287 fixes, −5,304 terser) | 381,850 B | 376,900 B |
| CSS | 100,256 B | 100,129 B (−127) | 103,000 B | 103,000 B |

The pages of an album, an artist and a list, the track menu, the list menu and
the playlist picker (one `Detail` page with a sticky side column and a table on a
desktop; menus and sheets that are entries of the navigation stack, so opening
one does not touch the rows) replace the old detail page, the menu drawn inside
the row and the picker's own dialog. Net of the deletions it adds 3,972 B of
script and 898 B of style (CSS stays under its limit); the new `Popover` and
`Overlays` chunks load when the app is idle, so the first script went down by
121 B. Opening a menu costs about the same main-thread time as before (a
13–21 ms task at 4x CPU throttling on Inicio, 11–17 ms on a 3,000-row Todas tus
canciones; the old row menu: about 13 ms), and dragging a row of a 300-row list
at 4x drops no frame over 33 ms on the phone viewport and one of 33 ms on the
desktop one:

| Bundle | After the review | After the pages and menus | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 376,382 B | 380,348 B (+3,966) | 376,900 B | 380,850 B |
| CSS | 100,129 B | 100,941 B (+812) | 103,000 B | 103,000 B |

The review of that change found one regression and fixed it with the rest of
its findings. The rows of a list were not memoized: the drag props were a new
object per row on every render, so each row that entered the window rendered all
of them, and a 300-row list scrolled with 23% more main-thread time than the old
page. They are now the same object between renders while nothing is dragged
(script time per fling of the 300-row list at 4x: 1,066 ms to 545 ms, main-thread
task 2,990 ms to 2,550 ms). `Popover` moved into the `Sheet` chunk (one chunk
less), the `songs` text and the menu and picker styles were written once, and
the menu styles load only with the menus, not with Buscar. The popover no longer
locks the scroll: it closes when the page scrolls, so the reserved scrollbar
gutter, which left a 10 px strip outside every full-screen scrim, is gone. The
fixes net -6 B of script and -86 B of style, and the JavaScript limit went down
from 380,900 B.

"Ahora suena" is one pane for every width: a full-screen view on a phone, a column
beside the pages on a desktop (and, wide, over them), with the Cola and Ficha tabs.
Its code lives in the `NowPlaying` chunk (13,189 B of script and 7,621 B of style,
from 7,395 B and 5,199 B for the old full-screen view), which loads when the app is
idle, so the always-parsed bundle only grew by 2 KB of script and 0.4 KB of style.
The review of that change measured one real cost and two sizes:

- **Expanding and collapsing the column** went through a View Transition that
  animated the pane's `width` and `height`, so every one of its 28 frames was a
  main-thread layout. At 4x CPU throttling a toggle cost 246 ms of main thread in
  the 900 ms after the click (72 ms in the first 120 ms, a 27 ms task, one dropped
  frame) and at 6x two dropped frames. It now reuses the fade the tabs use: 108 ms,
  30 ms in the first 120 ms, a 14 ms task, 0-1 dropped frames at 4x (re-run for
  the final build on a slower session: 419 ms, 99 ms, 45 ms and 1 dropped frame
  with the transition against 122 ms, 33 ms, 14 ms and 0 without). What is lost is
  the box morphing from column to page; the page changes at once and its content
  fades in. Reduced motion is unchanged.
- **The wide view** kept painting the pages behind it, which showed in the 12 px
  gap above and below the player bar and cost a third of its idle main-thread time
  at 4x (149 ms to 100 ms per 1.5 s). `.screens` is now `visibility: hidden` while
  wide: it stays laid out, so the scroll position survives.
- **The stylesheet** was 1,780 B over its limit. `lightningcss` as the CSS minifier
  gets it down by 1,952 B, but only with `build.cssTarget: "chrome111"` (the floor
  `color-mix()` already sets): with Vite's default target it lowers `inset` to four
  properties and the CSS gets 1.9 KB bigger. All 38 `color-mix()` calls are still
  in the built CSS. The dropped transition took 520 B more.

Opening the pane on a phone at 4x takes 214 ms of main thread (the old full-screen
view: 302 ms) and closing it 203 ms (210 ms); docking the column on a page costs
46 ms whatever the page (a 3,000-row list included, because the lists are
virtual); a track change re-renders the pane once, and the tick only the bar's
scrubber. The second `initials` and `becauseText`, and the two tab buttons of the
bar, went into one each (-370 B of script together with the transition code).

| Bundle | After the pages and menus | PR 6 before the review | After the review | Old limit | New limit |
| --- | --- | --- | --- | --- | --- |
| JavaScript | 380,348 B | 388,804 B (+8,456) | 388,434 B (+8,086) | 380,850 B | 388,950 B |
| CSS | 100,941 B | 104,780 B (+3,839) | 102,380 B (+1,439) | 103,000 B | 103,000 B |

The JavaScript limit is the measured size plus 500 B, rounded up to 50.

Descubrir and Ajustes (the map card with labels and rings in the colour of their
genre, the "Para ti" sheet and panel, and Ajustes as one page of sections) restyle
two screens that already had their structure, so the change is mostly deletions.
The sliding pill behind the old segmented controls (`.segs` and
`useSlidingPill`) is gone: the tabs of "Para ti" and the two choices in Ajustes
are the shared `.chip`s. The Ajustes rules (1,308 B of `.settings*`) left the
render-blocking first stylesheet for the Settings chunk, the Phosphor glyphs that
chunk carried became five stroke glyphs of the shared set, and the toast
Descubrir drew for itself is the provider's one (`NoticeProvider`). The labels of
the map are drawn in their genre's colour with a guard: the fit view still
labels 100 genres against 103 before (97%; the guard is 85%, and below it the
biggest tier would fall back to the text face). Net of the deletions it takes
2,345 B of script and 363 B of style off the totals, and the first stylesheet is
2,222 B smaller, so neither limit moves:

| Bundle | PR 6 after the review | After Descubrir and Ajustes | Limit | Headroom |
| --- | --- | --- | --- | --- |
| JavaScript | 388,434 B | 386,089 B (−2,345) | 388,950 B | 2,861 B |
| CSS | 102,380 B | 102,017 B (−363) | 103,000 B | 983 B |

| Chunk | Before (script / style) | After (script / style) |
| --- | --- | --- |
| `index-*` (first script and render-blocking stylesheet) | 229,881 B / 39,131 B | 229,930 B / 36,909 B |
| `SettingsView-*` (Ajustes) | 14,734 B / 2,873 B | 12,106 B / 4,723 B |
| `DiscoverView-*` (the map) | 23,505 B / 7,074 B | 23,561 B / 7,615 B |
| `ForYou-*` ("Para ti") | 18,700 B / 8,245 B | 18,727 B / 7,713 B |
| `chips-*` (shared) | — / 897 B | — / 897 B |

The measured size plus 500 B is 386,589 B of script and 102,517 B of style, both
under their limits, so `scripts/perf/budgets.json` is unchanged (lowering the
script limit to keep the gain is a separate decision). Nothing new is fetched
when Descubrir opens: the map's data and `/api/discover` load as before.

The review of that change measured the map's draw time per frame at 4x CPU
throttling, against the build before it:

| Gesture | PC before | PC after | Phone before | Phone after |
| --- | --- | --- | --- | --- |
| Pan fling | 5.5 ms | 6.3 ms | 4.9 ms | 5.1 ms |
| Wheel zoom (PC) / pinch zoom (phone) | 9.0 ms | 8.7 ms | 8.2 ms | 9.1 ms |
| Fit | 9.4 ms | 10.4 ms | 7.7 ms | 7.9 ms |

Coloured label text adds about 0.5 ms per frame. No frames drop beyond the old
build at 1x or 4x; at 6x both builds sit at the 16.7 ms edge. "Para ti" and
Ajustes cost the same as before, and the row that folds on dismiss has no frame
over 50 ms at 4x or 6x. The review fixed two things:
- The phone's full-bleed margin moved from the Descubrir screen to the map. A
  wider screen box made the tab View Transition scale the old screen by 0.91 or
  1.10 for about 120 ms.
- The row menu of the half-open "Para ti" sheet now opens upward when the tab
  bar would cover it.

Those fixes add 133 B of script and save 53 B of style.

The file verdict (PR 8: a verdict and its provenance stored per download, real
covers for audio, the genre card in Ahora suena, and the pills, the liner, the
file sheet, the chip and the bar that read them) is the last piece of the
redesign and the one that adds code instead of replacing it: five features that
were hidden until the data existed. Nothing new is fetched on a cold start and
no chunk is added to what opens first; the Ahora suena chunk asks for
`/api/artist/genres` when its card mounts and for `genre-map.json` (189 KB, once
per session) only if that answer has genres.

| Bundle | After Descubrir and Ajustes | After the file verdict | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 386,222 B | 392,865 B (+6,643) | 388,950 B | 393,400 B |
| CSS | 101,964 B | 104,067 B (+2,103) | 103,000 B | 104,600 B |

Both limits are the measured size plus 500 B, rounded up to 50. The script grew
by 6.6 KB across the five units (+307 B for the covers, +2,359 B for the genre
card, +3,988 B for the pills, liner, file sheet, chip and bar): the pure module
for the verdict texts and pills (`fileCheck`), the file sheet, the chip, the bar
pill, the genre card and its map matching (`genreChips`), and the wiring in the
rows, tables, liner and menu. The CI count adds every `.js`, so code that sits
in a lazy chunk counts in full. The `.vb` rules left the Buscar stylesheet for a
shared one (`shared/verdict.css`), so library rows do not import Buscar, and the
session-only store of library verdicts and the old pill and labels in
`download/` are gone. One tiny shared chunk (`genreRequest-*`) appeared because
Ahora suena, Buscar and Descubrir now all import the genre request slot.
After the review the verdict sentences moved from `fileCheck` to `fileText`,
which only the file sheet, the album liner and Ahora suena import: the boot
chunk is 1,044 B lighter for the same total, and the file sheet and the Ahora
suena card share one `.dfacts` block (CSS −200 B).

**Payload.** The per-file summary rides on `/api/library` and is written to
`localStorage` as well, so every byte is paid twice. Measured on a 3,000-track
library (`seed_library.py`, local SSD, Windows), compact JSON as served:

| `/api/library` | Bytes | Per file |
| --- | --- | --- |
| No records, no covers (a library from before PR 8) | 808,165 B | 269 B |
| + `thumb_key` and `thumb_s` on every row | 950,165 B (+142,000) | +47 B |
| + `verdict`, `meta_src`, `file_src` on every row, `real` on 12 % | 1,155,205 B (+205,040) | +68 B |

A file without a record gets no new field, so a legacy library is served the
exact bytes it was served before. The URLs, the matched title, the score and the
time stay in the shard: sending the full record would have cost about 450 B per
file. On the server `load_fileinfo` parses the 910 KB of shards in 18.5 ms and
the join takes 1.9 ms (3,000 records; the media scan itself is unchanged: 1.44 s
cold and 149 ms warm for 3,000 tracks). With both covers on every track the
folder lists 9,000 files. Covers are listed without a media-cache entry (there
is nothing to read in them), which keeps `media-cache.json` at the size of the
tracks alone (0.44 MB instead of 1.33 MB) and the warm scan at 172 ms instead of
233 ms (review numbers, same machine); the rest of the extra is the directory
entries, not the join. The iTunes cover fetch starts when yt-dlp starts and is
awaited only when the audio is ready, with a 5 s cap, so a slow CDN does not hold
a finished download. On Drive the records come from the 30-second
cache and one small file per device and month: a record is about 300 B, so a
download rewrites only its own month (25 KB at 83 records; the 3,000 records
above are 910 KB over the months they span).

**Covers on Drive.** Each cover is its own index entry, and every write
re-uploads the whole per-device index. The real `LibraryIndex` classes, 3,000
tracks:

| Index | Size | `to_bytes` | `from_bytes` |
| --- | --- | --- | --- |
| Audio only | 1,020,027 B | 45 ms | 33 ms |
| + 200 px cover | 1,911,027 B | 92 ms | 81 ms |
| + 200 px and ~100 px | 2,805,027 B | 151 ms | 130 ms |

At 300 tracks (the Pixel runs) the three sizes are 102 KB, 191 KB and 281 KB. A
download writes the audio and its two covers in one `put_files` call, so the
index goes up once (2.8 MB at 3,000 tracks) instead of three times in a row.
The covers themselves are 13.9 KB (200 px) and 5.3 KB (~100 px) from the iTunes
CDN (one cover measured during the design), about 57 MB for 3,000 tracks; they
are only fetched for downloads with an iTunes ficha, and rows ask for the small
one only.

**Genres.** `GET /api/artist/genres` reads the profiler's stored records through
the cache `/api/discover` already uses: a warm call is a dictionary lookup and
the credit split. It never starts the profiler and never touches the network.

The browser pass at 1x and 4x CPU throttling (frame times of the new table
column and pill cells, the fast-scroll gate with real covers, opening Ahora suena
with the chip) belongs to the review of the PR and is not in these numbers.

**Buscar portadas.** The opt-in tool that finds covers for files downloaded
before covers were stored (a «Portadas» card in Ajustes, the tool itself in its
own `CoverFinder-*` chunk) is new code, not a replacement. Nothing loads on a
cold start or when Ajustes opens: the chunk is fetched when the button is
pressed (or hovered on a desktop).

| Bundle | After the file verdict (`main`) | After Buscar portadas | Old limit | New limit |
| --- | --- | --- | --- | --- |
| JavaScript | 392,865 B | 401,845 B (+8,980) | 393,400 B | 402,350 B |
| CSS | 104,067 B | 107,857 B (+3,790) | 104,600 B | 108,400 B |

Both limits are again the measured size plus 500 B, rounded up to 50. The
`CoverFinder` chunk is 7,504 B of script and 3,737 B of style; the card and the
lazy import add 1,476 B to the Ajustes chunk. The CI count adds every `.js` and
`.css`, so the lazy chunk counts in full even though most sessions never load
it. On Drive, each confirmed cover is one `put_files` of its two sizes, so one
index write per file, the same as a download.

**Fixes from the v0.7.0 phone pass.** The track menu header now draws the
stored cover, and the yt-dlp verdict compares the video with the chosen iTunes
ficha instead of the typed query. JS 401,845 -> 401,877 B (+32, all in the lazy
`Overlays` and `PlaylistPicker` chunks; boot unchanged), CSS unchanged, limits
unchanged. The menu asks for the same 100 px URL the row already loaded, so it
adds no request: one cover request of 4,665 B with or without the fix. Time from
tapping «...» to the sheet painted (headless Chrome, 390x844, warm median of 8,
two runs per build), `main` -> fix: 23-33 -> 30 ms at CPU x1, 36-38 -> 34-37 ms
at x4, within this machine's noise. The verdict change is a string comparison
at download time and costs nothing measurable.

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
`--remove` deletes exactly those folders. `--thumbs [N]` adds a cover next to
the first N tracks, `--small-thumbs` the ~100 px `.s.jpg` beside each, and
`--verdicts` the stored verdict of every track (a shard under `.spitifo/`, so
`/api/library` carries `verdict`, `meta_src`, `file_src` and `real` on each row:
the worst case for the payload; `--remove` deletes it too). The 3,000-track runs
of the verdict work used
`--count 3000 --folders 300 --thumbs 3000 --small-thumbs --verdicts`. On the PC the library folder is
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
attaches to the page and reports, in this order:

- **startup**: launch to the app's navigation, first contentful paint, when
  `/api/library` answered, and launch to usable: `/api/library` answered **and**
  the first content of the mode the app opened on (Inicio) is rendered. When
  that content was already there at attach time the value is a lower bound
  (`usableBasis: "lower-bound"`: the latest of the library response, the mode's
  JS chunk and the first paint); otherwise it is observed. It also lists the
  mode bar in use (`leftnav`, `tabbar` or `dots`) and the viewport;
- **discoverOnStartup**: whether `genre-map.json`, `/api/discover` or the
  Discover JS chunk were requested before the first visit to Descubrir (taken
  4 s after start-up, once the idle preload has had its chance). Neither the
  map nor the API should be. The chunk is preloaded when the app idles, from
  any mode (it is the one chunk with a canvas to draw, so its first visit is
  where milliseconds show); `genre-map.json` is not, and is requested in the
  same gesture that opens Descubrir, in parallel with the chunk when it was not
  preloaded. `/api/discover` waits for the map to be drawn. The
  `afterRun` part shows what the visits requested afterwards (`/api/discover`
  once per visit to Descubrir, and again while the server is still working);
- **tapFeedback**: `pointerdown` on a segment of Buscar's "Modo de
  búsqueda" (a real control with `:active`; a mode bar button if it were gone)
  to the end of the next frame, with the press held so `:active` is read at
  that frame (`activeShown`, e.g. `3/3`; emulated touch never sets it, so check
  it on the phone);
- **modeSwitch**: a click on each button of the mode bar. `firstVisit` is the
  first, cold visit to Descubrir (straight from Buscar) and to Tu biblioteca;
  `toLibrary`, `toDiscover` and `toSearch` are `--runs` warm cycles
  Buscar → Tu biblioteca → Descubrir → Buscar. Per switch: `frame` (click to
  the end of the first frame), `shown` (the new screen is visible and its mode
  button is current, plus a frame: the View Transition has swapped the
  screens), `content` (the mode's own content painted: Tu biblioteca's
  search box and feed, Descubrir's map canvas **drawn**) and the longest frame while the
  switch settles;
- **libraryScroll**: opens "Explorar la biblioteca" from Inicio (the virtual list), flings
  three times down and up it, then closes it with "Volver". Frame rate, median
  and 95th percentile frame interval, share of frames over 1.5 refreshes,
  longest frame, and how far the page scrolled (`maxScrollPx`, a check that the
  fling moved). When the library scrolls less than one screen (13 tracks on
  Drive scroll 298 px in an 800 px window) there is not enough list to fling:
  the section is then `{ "skipped": "library scrolls less than one screen (N
  rows, P px)" }` instead of a warning;
- **discover**: `cold` is the click on Descubrir to the map's first drawn frame
  on the first visit, including the JS chunk (`chunkPreloaded`) and
  `genre-map.json`: its fetch, transfer size, body read and JSON parse
  (`jsonMs`), and the time from the response to the first draw
  (`responseToFirstDrawMs`, which adds `decodeMap`, the React render and the
  canvas). The first frame is the dots only: the label layout, the "Para ti"
  panel (a separate chunk, shown as a static frame first) and the
  recommendations request come after it. `warm` is the same click on later visits (the screen stays mounted,
  so this is the redraw after showing it again). Then `pan` (2 s of mouse
  drags in circles, or touch drags with `--touch`) and `zoom` (wheel, 1 s in
  and 1 s out) with the frame rate, the longest frame and the number of map
  redraws, and `panel`: closing and opening the "Para ti" panel (the side
  panel, or the sheet on a narrow screen) with the first frame and the longest
  frame while it moves.

Everything is taken inside the page. The map's first draw is noticed by
watching `clearRect` on the canvases inside `.gmap__view` (the one call each
redraw makes), and `genre-map.json`'s parse by wrapping `Response.json()`; those
two read-only wrappers are all `ui.mjs` injects, and the frontend carries no
measuring hook. A missing control stops the run with `ui.mjs: missing selector:
…` (or `timed out after … waiting for …`); a gesture that did not move the page
or the map is listed in `warnings` and the exit code is 2.

Run it three times and keep the medians. The timings start at the input
event's timestamp inside the page, so they leave out the operating system's
input latency and the display's scan-out (up to one more refresh); compare
them with each other, not with a camera.

Setting `SPITIFO_DATA_DIR` to an empty folder makes the app use the local
library with default settings without touching the user's own; leave it out to
measure the real setup.

To try the script without the installed app, against the checkout in any
Chromium (headless Edge or Chrome, `chrome.exe` takes the same flags; their
numbers are not the app's):

```bash
(cd frontend && npm run build)
SPITIFO_DATA_DIR=<empty folder> SPITIFO_LIBRARY=<seeded folder> \
    .venv/Scripts/python.exe -m uvicorn backend.app.main:app --port 8010
msedge --headless=new --remote-debugging-port=9333 --window-size=1280,800 \
    --user-data-dir=<temp folder> http://127.0.0.1:8010/
node scripts/perf/ui.mjs --endpoint http://127.0.0.1:9333 --runs 3 --reload
```

`--reload` loads the app's root URL again with the HTTP cache off, so the
start-up is observed and the chunks and `genre-map.json` are really fetched
(the app keeps the current mode in the URL, and a page left on Descubrir would
make the "cold" visit warm). With a narrow `--window-size` the same command
measures the tab bar and the bottom sheet; add `--touch` for touch drags (the
library fling then falls back to the mouse wheel's gesture, which a desktop
Chromium scrolls).

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
9333 and sends touch input. The mode bar is the tab bar and "Para ti" is the bottom
sheet there; the map is panned with touch drags, but the zoom is the mouse wheel
(there is no pinch), so `warnings` may report that it did not register. Keep the phone unlocked and untouched while it
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
