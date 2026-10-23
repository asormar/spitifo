# ADR 0003: Data sources and recommendation approach for Discover

- **Status:** Proposed (written while the owner was away; to be reviewed)
- **Date:** 2026-10-23
- **Context:** roadmap session 21 (Discover: research, no code). Sessions 22
  (the genre map) and 23 (recommendations) build on this.

## Decision

1. **The genre map is ours, built at build time from CC0 data only.** Nodes
   come from the MusicBrainz genre list (the genre entity is CC0) matched
   against Wikidata's "music genre" items (CC0). Edges come from Wikidata
   (`subclass of`, `influenced by`) and from artist–genre co-occurrence in the
   Discogs monthly dumps (CC0). A script lays the graph out in 2D
   (force-directed, or UMAP on a co-occurrence embedding) and writes a static
   file that ships with the app. Expect roughly 1,500–4,000 genres.
2. **Genres of the user's own artists come from MusicBrainz online**, looked up
   by artist name (then MBID) at the documented 1 request/s with a descriptive
   User-Agent, and cached per artist in the user's storage. Offline, or for an
   artist MusicBrainz does not know, the iTunes `primaryGenreName` the app
   already receives on search is the coarse fallback.
3. **Artist similarity is computed on the device first** (shared genres and
   tag overlap from the data above), and enriched online by ListenBrainz Labs
   `similar-artists`, cached per artist. Last.fm is not used: it needs an API
   key the app would have to ship, its terms cap cached data at 100 MB and
   require deleting it if access ends.
4. **Listening data stays in the user's storage and never leaves it by
   default.** It follows ADR 0002's model: each device writes only its own
   files, readers merge them.
5. **Recommendations are content-based and run on the device** (session 23):
   a decayed genre and artist profile from plays and likes, candidates from
   the similarity data, and a way to hear and download them through the
   existing Download search.

## Why not the obvious sources

| Source | Why not (sources checked 2026-10-23) |
| --- | --- |
| Every Noise at Once | 6,291 genres and the layout everyone knows, but no licence or dataset is published and it has been frozen since December 2023. Treat it as all rights reserved; use it only as inspiration. |
| Spotify Web API | Related artists, recommendations and audio features are blocked for new apps since 27 November 2024. |
| AcousticBrainz | Audio features would allow an acoustic map, but data collection ended in 2022: no recording after that. |
| Last.fm | Best folksonomy, but API key, non-commercial terms, attribution button, 100 MB cache cap and deletion on termination. Possible later as an opt-in. |
| Musicmap | About 230 genres, no licence found. |

## Licences and attribution

- MusicBrainz genre names and ids, Wikidata and the Discogs dumps are CC0:
  they can be bundled and transformed. Discogs' own dump page returned 403
  during the research; the CC0 status comes from the MusicBrainz wiki and a
  research catalogue, so it is confirmed before session 22 uses the dumps.
- MusicBrainz **tags and genre votes per artist** are CC BY-NC-SA 3.0. Spitifo
  is free and non-commercial, so caching them on the device is allowed with
  attribution; commercial use would need a MetaBrainz licence. They are never
  bundled.
- Settings gains an "Acerca de los datos" section crediting MusicBrainz,
  Wikidata, Discogs and ListenBrainz.

## Listening data

**Definitions** (the same as Last.fm and ListenBrainz, so an optional
scrobbler needs no translation):

- **Play:** the track is longer than 30 s and was listened to for at least
  half of it or 4 minutes, whichever comes first.
- **Skip:** the user moves on (next, previous, another track) after less than
  30 s and less than half of the track.
- **Partial:** anything in between. **Like:** a toggle, not an event.

Listened time is accumulated from `timeupdate` deltas, ignoring jumps over
1.5 s so a seek does not count as listening. One event is written when the
track's session closes (`ended`, a track change, closing the app), not one per
audio event. With repeat one, every `ended` is a play.

**Event** (about 70 B):

```json
{"t": 1792770000, "k": "Rosalía/Rosalía - Saoko.mp3", "d": 137000, "l": 137000, "r": "end", "o": "play", "dev": "d1"}
```

**Files**, next to `index-*.json` and `playlists-*.json`:

| File | Content | Merge |
| --- | --- | --- |
| `listens-<device>-YYYY-MM.json` | That month's events. Only the current month is rewritten. | Concatenate. |
| `listenagg-<device>.json` | Per track `{plays, skips, listened_ms, last, score}` and per artist the same, plus `folded_through`. | Sum counters, max of `last`, recompute `score`. |
| `likes-<device>.json` | `{key, liked, updated_at}` | Newest `updated_at` per key, like playlists. |

`score` decays with a 60-day half-life (`w = w·2^(-Δdays/60) + 1` per play,
−0.5 per skip); the half-life is a starting value to tune in session 23.
Events older than 12 months are folded into the aggregate and their monthly
files deleted. The artist aggregate matters because a track's key changes if
it is re-imported.

**Size** for a heavy listener (30 plays a day): about 770 KB of events a year
(65 KB a month), an aggregate of about 350 KB for 5,000 tracks plus 60 KB for
artists, and about 33 KB for 500 likes. Only the current month and the
aggregate are rewritten on a sync.

**Privacy:** nothing is sent anywhere by default. Scrobbling to ListenBrainz
can come later as an explicit opt-in with the user's own token, stored on the
device and never synced.

## The genre map on the device

Each genre stores its name, `x`/`y` quantised to 0–65535, a colour index and
3–5 related genre ids, as parallel arrays (columns) in JSON:

```json
{"version": 1, "built": "2026-10-23", "n": ["indie rock", "latin trap"], "x": [27012, 40311], "y": [48020, 12077], "c": [4, 11], "r": [[3, 9, 44], [12, 45, 300]]}
```

| Genres | Raw JSON | gzip (estimate) |
| --- | --- | --- |
| 1,500 | ~100–115 KB | ~35–45 KB |
| 3,000 | ~225 KB | ~80–100 KB |
| 6,000 | ~450 KB | ~130–160 KB |

The file ships with the app (Discover works offline from the first launch)
and is not counted by the JavaScript and CSS budgets; it is well inside the
installer's and the APK's headroom. A newer map can later be fetched once and
cached in the user's storage, with a version and checksum, falling back to the
bundled one.

**Drawing at 60 fps** (session 22): one canvas scaled by `devicePixelRatio`
(capped at 2), dots batched by colour, labels limited to about 200 per frame
with level of detail (only the most central genres at low zoom), a uniform
grid for hit-testing and label collisions, redraws only on pan, zoom or hover,
and related-genre edges only on hover. The user's genres (from the cache in
decision 2) are highlighted.

## Consequences

- The map clusters by scene and co-occurrence, not by sound: two genres are
  close because the same artists carry both tags. The UI says so instead of
  implying an acoustic layout.
- Building the map needs a script and the dumps at build time (session 22),
  not at run time. The output is reviewed like code.
- Discover needs the network for genres and similarity of new artists;
  cached results keep working offline.
- **Risks:** Spanish and Latin coverage in MusicBrainz and Discogs was not
  verified and may be thin; ListenBrainz Labs endpoints are not guaranteed to
  stay stable; Discogs' CC0 status is confirmed only second-hand.

## Open before session 22

- Confirm the Discogs dump licence at the source.
- Measure MusicBrainz genre coverage on a sample of real Spanish and Latin
  artists (the user's library is a good sample).
- Pick force-directed or UMAP by trying both on the real graph.

## Sources

- MusicBrainz: https://musicbrainz.org/doc/MusicBrainz_Database/Download,
  https://musicbrainz.org/doc/Genre, https://musicbrainz.org/genres,
  https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting,
  https://metabrainz.org/api
- ListenBrainz: https://labs.api.listenbrainz.org/,
  https://listenbrainz.readthedocs.io/en/latest/users/api/core.html
- Last.fm: https://www.last.fm/api/tos, https://www.last.fm/api/scrobbling,
  https://www.last.fm/api/show/artist.getSimilar
- Wikidata: https://www.wikidata.org/wiki/Wikidata:Licensing
- Discogs (CC0 note): https://musicbrainz.org/doc/Geordi/Potential_data_sources
- Every Noise at Once: https://en.wikipedia.org/wiki/Every_Noise_at_Once,
  https://artists.spotify.com/it/blog/how-spotify-discovers-the-genres-of-tomorrow
- Spotify Web API changes: https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api
- AcousticBrainz: https://acousticbrainz.org/
- Spotify stream counting: https://support.spotify.com/dj-en/artists/article/how-your-streams-are-counted/
