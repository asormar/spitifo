# ADR 0004: Saved songs registry

- **Status:** Proposed (approved by the owner; step 2 of 7)
- **Date:** 2026-11-20
- **Context:** the owner's library lives in their own storage (ADR 0002). Until
  now "the library" was only the list of downloaded files (`GET /api/library`).
  The owner approved a redesign: a song can be **saved** to the library without
  being downloaded — it then plays by streaming — and downloading becomes an
  optional extra. This ADR covers the backend registry and its API only.

## Decision

The library keeps a separate registry of saved songs, independent of the files
on disk. A `SavedSong` carries metadata (title, artist, album, duration,
artwork), its provenance (`source`, `source_id`, optional `itunes` ids) and an
optional `file_key`: the library key of its downloaded file, if any. A song with
no `file_key` is still in the library and plays by streaming.

**Identity rules.** The `id` is stable and is never a URL, because stream URLs
expire:

- YouTube: `yt:<videoId>`, where the video id matches `[A-Za-z0-9_-]{11}`.
- Internet Archive: `ia:<identifier>/<file>`. The identifier matches
  `[A-Za-z0-9._-]{1,100}`. The file is part of the identity because one item
  can hold a whole album. It may sit in a subfolder of the item, and it may not
  contain `:`, `?`, `#`, `\`, control characters, or empty, `.` or `..`
  segments.

`id`, `source` and `source_id` must agree — the id is composed from the other
two — and the rules above rule out URLs (`:`, `?`) by construction.
`validate_song_id` is strict and shared by the model and the API.

**Storage files**, following ADR 0002's per-device model exactly:

| Where | File |
| --- | --- |
| Local disk | `.spitifo/library.json` (atomic write, hidden from `list()`) |
| Cloud | `library-<device>.json` next to `index-*.json` and `playlists-*.json` |

`library-` is not a substring of any other small-file prefix (or vice versa),
so the Drive `name contains` listing cannot mix registries. Each device writes
only its own file; a save is one upload. An own file that cannot be read is
never overwritten, and a transient read failure is retried once.

**Merge.** Readers merge every device's file per id: the newest `updated_at`
wins; on a tie the tombstone wins, so a deletion is never resurrected by an old
copy. `live()` returns the non-deleted songs, newest `added_at` first. Saving an
existing id keeps its `added_at` and advances `updated_at` even if the device
clock went back; removing writes a tombstone.

## Out of scope for this step

No frontend changes, no playback changes (streaming a saved song), no automatic
linking between a saved song and a downloaded file, and no migration of existing
downloads into the registry. Those are later steps; this one adds only the
model, the storage ports and `GET /api/saved`, `PUT /api/saved` and
`POST /api/saved/remove`.
