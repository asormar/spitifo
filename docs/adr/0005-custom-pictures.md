# ADR 0005: Custom pictures for songs, albums and artists

- **Status:** Proposed (approved by the owner; step 6a of the library redesign)
- **Date:** 2026-11-20
- **Context:** the owner wants to change the picture of a song, an album or an
  artist, including uploading an image of their own. The library already stores
  small per-device registries (ADR 0004) and serves cover sidecars through
  `/api/audio?key=`. This ADR covers the backend registry, files and endpoints
  only; the frontend resize step is the next PR.

## Decision

### Model

A new `ArtBook` registry, following `SavedBook` exactly. An `ArtRecord` holds a
`target`, the two Storage keys (`key`, `small_key`), a `source`
(`upload`, `itunes`, `youtube` or `archive`), `updated_at` and `deleted`.
Readers merge every device's file per target: the newest `updated_at` wins and
on a tie the tombstone wins, so a reset is never resurrected by an old copy.
`live()` returns the non-deleted records.

**Targets** are strings, never URLs:

- `song:<id>` — either a saved song id (`yt:<videoId>` or
  `ia:<identifier>/<file>`, validated by `saved.validate_song_id`) or a library
  file key (`storage.validate_key`).
- `album:<text>` and `artist:<text>` — the frontend's folded grouping id:
  lowercase, at most 300 characters, no control characters.

Anything else is rejected with 422. A target containing a URL cannot pass these
rules (`://`, `?` and uppercase are ruled out by construction).

### Storage files

| Where | File |
| --- | --- |
| Local disk | `.spitifo/art.json` (atomic write, hidden from `list()`) |
| Cloud | `art-<device>.json` next to `index-*.json` and `library-*.json` |

`art-` joins `SMALL_PREFIXES`, so it is listed, cached in the local small-file
snapshot and merged like every other per-device file. Each device writes only
its own file; a save is one upload. An own file that cannot be read is never
overwritten, and a transient read failure is retried once — the same rule as
playlists, saved songs and the library index.

### Content-addressed images

The two JPEGs live under `.art/`:

```
.art/<sha256-of-the-big-JPEG-hex>.jpg
.art/<sha256-of-the-big-JPEG-hex>.s.jpg
```

Both names derive from the **big** image's bytes, so identical bytes always get
identical keys. Two devices can never clash, and re-uploading the same picture
is free: the API checks `stat()` for both keys and skips `put_files` when they
already exist. The pair is always written with one `put_files` call (one index
write on Drive).

`.art` is a dot-directory. Both Storage adapters skip dot-prefixed paths in
`list()` (local) and dot-prefixed key segments in the merged index (cloud), so
these files never appear as library rows, as orphan covers in `library_scan`,
or in the cover finder's "missing covers" list. Because the content is
immutable, `/api/audio?key=.art/...` serves it with a one-year
`Cache-Control: private, max-age=31536000, immutable`.

### Why the browser resizes

Spitifo runs embedded on Android through Chaquopy and there is **no Pillow (or
any other image library) available**, and none may be added. The frontend
therefore draws the upload on a canvas and sends two ready JPEGs: `image`
(<= 2 MB decoded) and `small` (<= 300 KB decoded), as base64. The backend only
checks the JPEG magic bytes `FF D8 FF` and the sizes; it never decodes or
re-encodes a picture.

### `from-url` allow-list

`POST /api/art/from-url` accepts only https URLs, no credentials, no unusual
port, no query or fragment, on hosts the app already uses for artwork, and the
`source` must match the host family:

| source | host |
| --- | --- |
| `itunes` | `mzstatic.com` and its subdomains |
| `youtube` | `i.ytimg.com` (exact) |
| `archive` | `archive.org` and its subdomains |

Redirects are followed at most twice and each target is checked again against
the same list. For `mzstatic` URLs ending in `/NxNbb.jpg` the CDN is asked for
`600x600bb.jpg` and `120x120bb.jpg`, exactly as `covers.py` does; for the other
hosts there is no server-side resizing, so the same bytes are stored for both
keys. Non-JPEG responses are rejected with 422. The existing httpx client,
timeout and User-Agent settings are reused.

`POST /api/art/reset` writes a tombstone. Images are left in `.art/`; garbage
collection is out of scope for this step.

## Endpoints

- `GET /api/art` — `{"art": {target: {"key", "small_key", "source"}}}`
- `POST /api/art/upload` — `{target, image, small}` (base64 JPEGs)
- `POST /api/art/from-url` — `{target, url, source}`
- `POST /api/art/reset` — `{target}`

All Storage work runs in `asyncio.to_thread`, as in the saved-songs routes.

## Out of scope

No frontend changes, no applying a custom picture while rendering a song,
album or artist, no image resizing on the server, no garbage collection of
unused `.art/` files, and no migration of existing cover sidecars into the
registry.
