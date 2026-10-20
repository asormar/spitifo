<div align="center">

# 🎵 Spitifo

**Search a song, download it in full — with the tags already written**

Free-licence catalogues + YouTube as a last resort · Identity verification on every file

![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)
![Starlette](https://img.shields.io/badge/Starlette-1.7-009688)
![React](https://img.shields.io/badge/React-18-20232A?logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![yt-dlp](https://img.shields.io/badge/yt--dlp-ff0000?logo=youtube&logoColor=white)
![mutagen](https://img.shields.io/badge/mutagen-43B02A?logo=python&logoColor=white)

<img src="docs/app-home.png" alt="Spitifo home screen: dark interface with search bar, mode selector (Music / All sources / YouTube) and format selector" width="820">

*Local-first. No accounts, no cloud, no tracking.*

</div>

---

## Table of contents

- [Overview](#overview)
- [The hard part: knowing what you downloaded](#the-hard-part-knowing-what-you-downloaded)
- [How the sources work](#how-the-sources-work)
- [The matcher](#the-matcher)
- [Results in the browser](#results-in-the-browser)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Embedding the backend](#embedding-the-backend)
- [API](#api)
- [Project structure](#project-structure)
- [Tests](#tests)
- [Legal](#legal)

## Overview

Most "download this song" tools hand you a file and stop. Spitifo goes one step
further: after every download it **opens the file and checks that it is actually the
song you asked for**, and if it isn't, it says so in plain language.

That single feature is what the rest of the project is built around. It exists because
the obvious implementations are quietly wrong:

- Internet Archive stores **one item per track**, but titles the item after the
  *concert*. Search "Bohemian Rhapsody" and you get a Phish show because that song is
  number 21 on the setlist.
- The audio filenames are meaningless: `ph2022-12-31_s3t04.mp3` never says which song
  it holds.
- YouTube is full of rips, covers and hour-long compilations, all titled "Bohemian
  Rhapsody".

So a naive downloader will confidently save you 45 seconds of the wrong track and call
it a day.

| Feature | What it does |
| --- | --- |
| **Identity verification** | Reads the real ID3 tags of the downloaded bytes and scores them against your query. Reports `match`, `partial`, `mismatch` or `unknown`. |
| **Honest file naming** | A mismatch is saved under the title actually in the file, never under the title you searched for. |
| **Multi-source search** | Internet Archive, Wikimedia Commons, iTunes and Jamendo queried in parallel, then merged and de-duplicated. |
| **Matched mode** | iTunes supplies clean metadata; yt-dlp supplies the full-length audio. Best of both. |
| **Concurrent downloads** | Every download is tracked independently: its own progress toast, its own spinner, its own auto-dismiss. |
| **Light and dark themes** | Follows your system preference, remembers your choice, no flash on load. |
| **Built-in player** | Custom scrubber, volume and keyboard controls. Native `<audio>` chrome is hidden on purpose. |
| **Show grouping** | Archive concerts expand into their real setlist, each track downloadable on its own. |

## The hard part: knowing what you downloaded

After the audio lands on disk, `identify.py` reads the **first 256 KB** with mutagen and
compares the parsed tags against your query. The comparison is a word-overlap score with
stopwords removed (`live`, `remix`, `feat.`, `version`, `remaster…`).

| Verdict | Meaning | What you see |
| --- | --- | --- |
| `match` | ≥ 0.8 overlap — this is the track you asked for | nothing, it's fine |
| `partial` | ≥ 0.4 — related, but not certainly the same recording | nothing |
| `mismatch` | **this is not what you searched for** | a warning naming the real title |
| `unknown` | the file carries no tags to check | a warning: *could not verify* |

Two deliberate decisions here:

**`unknown` warns too.** "I could not verify this" is more honest than a green tick that
nobody ever issued.

**The filename comes from the file.** If a download does not match, it is written to disk
under the title its tags actually contain. The file on your disk never lies about its
own contents.

> [!NOTE]
> The verdict is computed **after** the download, against the real title of the file that
> landed — not against the metadata you searched with. Publishing it through the job
> payload is what lets the UI show it without a second round trip.

## How the sources work

| Source | Status | What you actually get |
| --- | --- | --- |
| **Internet Archive** | Works, no key | Full downloads. Live concerts, 78rpm transfers, community uploads |
| **Wikimedia Commons** | Works, no key | Full downloads. CC and public-domain audio |
| **iTunes Search** | Works, no key | Huge, clean catalogue — but **30-second previews only** |
| **Jamendo** | Needs `JAMENDO_CLIENT_ID` | Full MP3s from independent artists (free key) |
| **yt-dlp** | Off by default | Full-length audio from YouTube — see [Legal](#legal) |

The asymmetry in that table *is* the design problem. iTunes has the best metadata and
the worst audio; YouTube has the audio and the worst metadata. Matched mode exists to
join them.

### Two traps worth knowing about

**Archive is not just music.** It is audio in general. Searching `Numb Linkin Park`
returns *"HUBS report"*, *"Chaos in Portland"* and *"Toe sucking burglar strikes in
Florida"*. Two filters in `sources.py` prevent that:

- `looks_like_music()` drops titles carrying podcast / news / sermon / audiobook words.
- `relevance()` scores 0–1 and requires the item to contain **most of the distinctive
  words** of your query. An item matching only "park" scores 0.13; the correct one, 0.67.

Together they turn a search whose first three hits were podcasts into one where every
result is music. **Apply both to any new source.**

**Archive needs AND between words.** `advancedsearch` requires every term, so
`"linkin park numb"` returns zero even though *Meteora* is uploaded. The adapter tries
progressively looser variants and falls back to an OR over the longest words, then
re-ranks by real relevance. And `httpx` needs `params` as a **list of tuples** — repeating
keys in a dict silently returns documents with every field empty.

## The matcher

Matched mode pairs each iTunes track with the right YouTube video. This is not a
similarity search: *Bohemian Rhapsody* exists by Queen, by Panic! At the Disco and by
Pentatonix, and "closest title wins" sent all three to Queen's video.

| Signal | Weight | Why |
| --- | --- | --- |
| Channel name contains the artist | +0.3 | Strongest and cheapest signal available |
| Title matches **and** duration within 12 s | +0.2 | Separates covers and live versions |
| Duration off by more than 90 s | Reject | Live vs studio, remix vs original |
| No channel **and** no (title + duration) | **No match** | Better to say "none" than to download the wrong song |

A video is never reused for two different tracks.

<div align="center">

| Query | Behaviour |
| --- | --- |
| `bohemian rhapsody` | Queen → Queen official, Panic! → a different video, Pentatonix → a different video |
| `pink floyd` | Reports "no full version" for 5 of 6 instead of inventing one |

</div>

## Results in the browser

<img src="docs/app-results.png" alt="Search results as a card grid: album artwork, title, artist and album, provenance line reading 'ficha: iTunes · archivo: YouTube', duration, a 30-second preview player and a download button labelled Completo" width="820">

Each card states where **every** piece of data came from:

> `ficha: iTunes` · `archivo: YouTube` · `3:07` · vídeo · procedencia

The labels are not decoration. In matched mode iTunes only *contributes metadata* while
yt-dlp *downloads the audio*, so an unlabelled "iTunes · 3:07" reads as if the complete
track came from iTunes — which would be false, since iTunes only serves 30-second
previews.

**Verified accessibility:** every text/background pair was measured, not eyeballed.
The lowest ratio in either theme is **6.04:1** (dark) and **7.43:1** (light), all above
the WCAG AA threshold of 4.5:1. The layout is verified down to 390 px wide with no
horizontal overflow and 44 px minimum touch targets.

## Getting started

**Requirements:** Python ≥ 3.11, Node.js ≥ 18, and **ffmpeg** on your `PATH` for format
conversion. Without ffmpeg everything still works, but choosing mp3 or m4a for a file
published in another format (`.flac`, `.ogg`, `.opus`, `.wav`) stores it unconverted.
The `original` format never converts: free-licence files are kept exactly as published,
while YouTube downloads keep their audio stream without re-encoding (usually `.opus` or
`.m4a`).

```bash
git clone https://github.com/asormar/spitifo.git
cd spitifo

python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows
# .venv/bin/pip install -r requirements.txt        # macOS / Linux

cd frontend && npm install && npm run build && cd ..
```

The API serves the built frontend, so everything runs on one port:

```bash
.venv/Scripts/python.exe -m uvicorn backend.app.main:app --port 8000
```

Open **http://127.0.0.1:8000**.

<details>
<summary><b>Frontend development</b></summary>

```bash
cd frontend
npm run dev      # http://localhost:5173, proxies /api to :8000
```

Vite reloads on save. Run the backend separately as shown above.

</details>

<details>
<summary><b>Enabling the YouTube source</b></summary>

```bash
# PowerShell
$env:YTDLP_ENABLED=1
.venv\Scripts\python.exe -m uvicorn backend.app.main:app --port 8000
```

`run.bat` in the repo root already sets this for you on Windows.

Read the [Legal](#legal) section before you do.

</details>

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPITIFO_LIBRARY` | `./library` | Where downloads are written |
| `SPITIFO_FRONTEND_DIST` | `./frontend/dist` | Built frontend to serve (point it elsewhere when embedded) |
| `SPITIFO_HOST` | `127.0.0.1` | Interface the backend binds (entry point only) |
| `SPITIFO_PORT` | `0` | Port to bind; `0` picks a free one (entry point only) |
| `SPITIFO_TOKEN` | — | Per-launch secret; unset means no auth |
| `SPITIFO_FFMPEG_DIR` | — | Directory with `ffmpeg`/`ffprobe`, prepended to `PATH` |
| `SPITIFO_YTDLP_DIR` | — | Directory with a newer `yt_dlp/` (or the official yt-dlp zip), put first on `sys.path` so it wins over the bundled one |
| `SPITIFO_QJS` | — | Path to a QuickJS (`qjs`) binary; when it exists, yt-dlp uses it as its JavaScript runtime |
| `JAMENDO_CLIENT_ID` | — | Enables the Jamendo source (free key) |
| `YTDLP_ENABLED` | `0` | Enables the yt-dlp source |

Downloads land in `library/<artist>/<artist> - <title>.mp3` with ID3 tags written by
mutagen: canonical title, artist, album and year taken from the metadata source, not
from the YouTube video title.

## Embedding the backend

`python -m backend.app` starts the same app as `uvicorn`, but tells the caller which port
it ended up on and when it is ready — which is what a native shell needs (Tauri on
Windows, Chaquopy plus a WebView on Android):

```bash
.venv/Scripts/python.exe -m backend.app --port 0
SPITIFO_READY port=51234
```

`--port 0` (the default) lets the OS pick a free port. Once the server is listening, one
line goes to **stdout** and is flushed:

```
SPITIFO_READY port=51234
```

Parse the port from it, then talk to `http://<host>:<port>`. Everything uvicorn logs stays
on **stderr**, so that line is the only thing on stdout. `--host` and `--port` fall back
to `SPITIFO_HOST` and `SPITIFO_PORT`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPITIFO_HOST` | `127.0.0.1` | Interface to bind |
| `SPITIFO_PORT` | `0` | Port; `0` picks a free one |
| `SPITIFO_TOKEN` | — | Per-launch secret; unset means no auth |
| `SPITIFO_LIBRARY` | `./library` | Where downloads are written |
| `SPITIFO_FRONTEND_DIST` | `./frontend/dist` | Built frontend to serve |
| `SPITIFO_FFMPEG_DIR` | — | Directory with `ffmpeg`/`ffprobe`, prepended to `PATH` |
| `SPITIFO_YTDLP_DIR` | — | Directory with a newer `yt_dlp/` (or the official yt-dlp zip), put first on `sys.path` so it wins over the bundled one |
| `SPITIFO_YTDLP_AUTOUPDATE` | `1` | `0` turns off the daily background check for a newer yt-dlp |
| `SPITIFO_QJS` | — | Path to a QuickJS (`qjs`) binary; when it exists, yt-dlp uses it as its JavaScript runtime |
| `YTDLP_ENABLED` | `0` | Enables the yt-dlp source |

`SPITIFO_TOKEN` is the per-launch secret. On Android any app on the phone can reach
`127.0.0.1`, and the backend is meant to hold the user's cloud tokens, so the shell
generates a random secret and passes it in. With it set, a request must send
`X-Spitifo-Token: <secret>` or it is refused with `401`. The WebView bootstraps once by
loading `/?token=<secret>`: the backend answers `303` with the token param removed, sets
an `HttpOnly`, `SameSite=Strict` cookie, and afterwards cookies keep the `<audio>`
element working with no header at all. With `SPITIFO_TOKEN` unset there is no auth:
today's behaviour.

`SPITIFO_FFMPEG_DIR` exists because Android has no `ffmpeg` on `PATH` — the app ships one
and points here. The backend prepends it to `PATH` at startup, so the unchanged
downloader and yt-dlp find `ffmpeg` and `ffprobe`. The audio MIME types (`.mp3`, `.m4a`,
`.ogg`, `.opus`, `.flac`, `.wav`) are registered explicitly for the same reason: Android
ships no MIME database, and without them `.ogg` was served as
`application/octet-stream`.

`SPITIFO_YTDLP_DIR` lets a newer yt-dlp replace the bundled one without a new app release
(YouTube breaks yt-dlp several times a year). It can point to a directory that contains
`yt_dlp/` or to the official zip-importable `yt-dlp` file; the backend puts it first on
`sys.path` at startup, before anything imports the engine. The version actually in use is
reported by `GET /api/health` as `ytdlp_version` (`null` if yt-dlp cannot be imported).

The backend also updates yt-dlp by itself: on start, in the background and at most once
a day, it looks up the latest yt-dlp release, downloads the official `yt-dlp` file into
the update directory (`SPITIFO_YTDLP_DIR`, or `yt-dlp/` under the data dir), checks it
against the release's `SHA2-256SUMS` and records it in `current.json`. The next start
loads it, unless the bundled yt-dlp is newer. `GET /api/health` reports a downloaded
version still waiting for that restart as `ytdlp_pending`. A `SPITIFO_YTDLP_DIR` without
`current.json` is treated as managed by hand and never updated.

### Surviving YouTube without an account

YouTube increasingly requires solving a JavaScript challenge, and sometimes shows a
"confirm you're not a bot" wall. Two optional escapes, both account-free by default:

`SPITIFO_QJS` points to a [QuickJS](https://github.com/quickjs-ng/quickjs) `qjs` binary.
When the file exists the backend hands it to yt-dlp as its JavaScript runtime
(`js_runtimes={'quickjs': {'path': ...}}`) so it can solve the challenge; `GET /api/health`
reports this as `js_runtime` (`"quickjs"`, or `null`). The backend also asks yt-dlp for a
fallback set of extractor clients (`player_client`: `default`, `android_vr`,
`web_embedded`), merged on top of whatever is already configured.

Cookies are the last resort. `POST /api/youtube/cookies` imports a Netscape `cookies.txt`
(either a multipart `file` field or a raw text body); only `youtube.com`/`google.com` lines
are kept, and the file is stored under the data dir, encrypted with DPAPI on Windows (0600
elsewhere). `GET` reports `{configured, imported_at, count}` and `DELETE` forgets it — the
cookie contents are never returned or logged. Cookies are **never** used on the first
attempt: only when a download hits the bot-check wall is it retried once with a throwaway
plaintext copy deleted right after. Without cookies that failure comes back with the
`youtube_bot_check` code, which the frontend turns into an "import cookies" prompt. Using an
account risks a ban; a secondary account is advisable.

## API

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Which sources are active right now, and the yt-dlp version in use |
| `GET` | `/api/search` | Search every active source (`mode`, `source`, `limit`) |
| `POST` | `/api/resolve` | Turn a catalogue entry into a playable URL |
| `GET` | `/api/verify` | Inspect what is inside an item without downloading it |
| `GET` | `/api/setlist` | Expand an Archive concert into its real setlist |
| `POST` | `/api/download` | Start a download; returns a `job_id` |
| `GET` | `/api/download/progress/{job_id}` | Progress, speed, ETA and identity verdict |
| `GET` | `/api/library` | Everything already downloaded, with durations |
| `GET` | `/api/youtube/cookies` | Whether a `cookies.txt` is imported, and when |
| `POST` | `/api/youtube/cookies` | Import a `cookies.txt` (multipart `file` or raw body) |
| `DELETE` | `/api/youtube/cookies` | Forget the imported cookies |
| `GET` | `/api/audio?path=` | Stream a file from the library |

<details>
<summary><b>Search modes</b></summary>

| Request | Result |
| --- | --- |
| `mode=matched` (default) | iTunes metadata + yt-dlp audio |
| `mode=ytdlp` alone | Does **not** filter — returns every source |
| `mode=ytdlp&source=ytdlp` | YouTube only |
| `mode=matched&source=X` | **Degrades matched mode** and loses the pairing |

That last row is a real trap in the API: combining a source filter with matched mode
silently falls back to a plain search. The UI derives the source from the mode
automatically so you cannot hit it by clicking.

</details>

## Project structure

```
backend/app/
  main.py          Starlette app, routes, request validation, background downloads
  __main__.py      Embeddable entry point: free port, SPITIFO_READY line
  security.py      Per-launch secret (SPITIFO_TOKEN) middleware
  runtime.py       Startup setup: ffmpeg directory, audio MIME types
  sources.py       Source adapters, anti-noise filters, relevance ranking
  ytdlp_source.py  YouTube via yt-dlp: formats, ffmpeg postprocess, progress, locks
  youtube_cookies.py  Imported cookies.txt (last resort), encrypted at rest
  matcher.py       Pairs metadata entries with the right video
  identify.py      Reads real tags and scores them against your query
  downloader.py    Streaming, ffmpeg conversion, ID3 writing, library scan
  models.py        Track type and filename sanitisation
  config.py        Shared constants
frontend/src/
  main.jsx         Entry: fonts, stylesheets in cascade order, mounts the app
  app/             Shell: header, theme switch, library drawer, settings dialog
  download/        Search, result cards, pickers, downloads (loaded lazily)
  player/          Playback engine, players, mini-player, video host, library
  settings/        Storage dialog and YouTube cookies (loaded on first use)
  shared/          API helpers, formatting, theme, design tokens and motion
docs/              Roadmap, ADRs, the release guide (docs/release.md) and the screenshots used in this README
tests/             179 tests, offline by default
```

## Tests

```bash
.venv/Scripts/python.exe -m pytest -m "not integration" -q   # offline, ~2 s
.venv/Scripts/python.exe -m pytest -q                         # everything, needs network
```

**179 tests, 8 of which need the network. Offline: 170 pass, 1 xfail.** The xfail is a deliberately strict marker on
`looks_like_music()`, which does not yet reject the Spanish word *curso*; the day
someone fixes it, the test fails and forces the marker to be removed.

One integration test is **intermittent**: `test_search_resolve_download_verifica_tags`
depends on an Internet Archive node that intermittently answers `403 Forbidden`, so a
given run reports it either as a failure or as a skip. It is external flakiness, not a
regression — the same suite passes fully when the node answers.

What is actually covered, beyond the usual:

- **The matcher runs fully offline** against a fake YouTube source, including the
  Bohemian Rhapsody regression where three same-titled tracks must resolve to three
  different videos.
- **Concurrent downloads of the same track** are tested by faking `yt_dlp` and making
  the second download fail with `OSError(32)` exactly as Windows would. The test asserts
  the two never touch the file at the same time — and it was verified to fail when the
  lock is removed.
- **Integration tests** hit the real APIs with explicit timeouts and skip with a stated
  reason when an external service fails. An assertion is never rewritten to make a test
  pass.

> [!IMPORTANT]
> `testpaths = tests` in `pytest.ini` is load-bearing. Without it pytest collects from
> the repository root and the whole suite fails during collection.

## Legal

> [!WARNING]
> **The yt-dlp source downloads from YouTube.** That violates YouTube's Terms of
> Service and is unlawful in most jurisdictions, including Argentina and the European
> Union. It ships here disabled (`YTDLP_ENABLED=0`).

Everything else in Spitifo is built on sources that are meant to be used this way:
Internet Archive, Wikimedia Commons, iTunes previews and Jamendo. Those work without
the flag.

The tool is published for personal study and experimentation. If you intend to
redistribute it, host it as a service, or use it commercially, **check what applies in
your jurisdiction first** — that is your call to make, not this repository's.

## License

MIT.

The music itself is not part of this repository. What you download is subject to the
licence of whichever source it came from; the provenance link on every result tells you
which one that was.
