# ADR 0002: User-owned storage, connectors and the `Storage` port

- **Status:** Accepted (first provider, Google Drive, confirmed by the
  benchmark in roadmap session 7)
- **Date:** 2026-10-16
- **Context:** roadmap session 2 (research only), branch
  `docs/storage-exploration`. Builds on
  [ADR 0001](0001-android-embedded-python.md).

## Context

Spitifo runs its backend inside each app on `127.0.0.1` and has no central
server. Music stays on the device by default; a user may connect their own cloud
storage. The app is open source and distributed through GitHub Releases, so
OAuth client IDs ship inside the binary.

A **companion player app** is planned that reads the same storage to play the
music. Playback has to feel instant: no multi-second wait after pressing play,
and no stalls.

## Decisions

### 1. Providers

| Provider | Free | Auth | Visible folder | Verdict |
| --- | --- | --- | --- | --- |
| Google Drive | 15 GB, shared with the Google account | Public client + PKCE, `drive.file` scope | Yes: a normal `Spitifo` folder created by the app | **Preferred first connector** |
| OneDrive (personal) | 5 GB | Public client + PKCE, `Files.ReadWrite.AppFolder` | Yes: `Apps/Spitifo` | **Fallback first connector** |
| Dropbox | 2 GB | Public client + PKCE, App Folder | Yes: `Apps/Spitifo` | **Rejected for now** |
| Cloudflare R2, Backblaze B2 | 10 GB | Access keys pasted by the user | No | Later, power users only |
| WebDAV / Nextcloud | Depends on the server | URL + app password | Yes | Later, power users only |

- **Google Drive.** `drive.file` is a non-sensitive scope: Google states that app
  verification "is not mandatory" for it. Only the lighter brand verification is
  needed to show the app name and logo on the consent screen
  ([source](https://support.google.com/cloud/answer/13463073)). The consent
  screen must be set to "In production": in "Testing", refresh tokens expire
  after 7 days ([source](https://developers.google.com/identity/protocols/oauth2)).
  Google's hidden `appDataFolder` is not used, because users must see their
  files.
- **OneDrive.** No user cap and no mandatory review for personal accounts.
  Refresh tokens last 90 days and rotate on every use
  ([source](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)).
- **Dropbox.** Development mode allows 500 users, and after 50 the app must pass
  a production review. Its developer guide says it will not approve apps that let
  users "download content from other services without having the proper legal
  rights" ([source](https://docs.dropboxapi.com/dropbox-api/docs/developer-resources/developer-guide)).

### 2. Choosing the first connector by measurement

Session 7 starts with a short benchmark against real Google Drive and OneDrive
accounts, on the Pixel and on Windows:

| Metric | Target |
| --- | --- |
| Time from pressing play to first audio, uncached track | p50 < 1 s |
| Stalls during a full track on 4G | none |
| Seek to the middle of an uncached track | p50 < 1 s |
| Android sign-in that survives an app restart without user interaction | works |

Google Drive is chosen if it meets every target. The Android sign-in is its
known risk: Google requires its Identity Services SDK on Android, and its
documented long-lived (offline) access assumes a server that receives the
authorization code ([source](https://developer.android.com/identity/authorization)).
Short-lived access tokens that renew silently while the app is open may be
enough; the benchmark settles it. Otherwise OneDrive is first.

### 3. OAuth

- Authorization code with PKCE in the system browser everywhere. Never a WebView,
  never the implicit flow (RFC 8252).
- **The Python backend owns the flow:** it generates PKCE and `state`, exchanges
  the code, refreshes and stores tokens. The shell only opens the browser and, on
  Android, passes the redirect to Python in-process.
- **Windows:** loopback redirect to `127.0.0.1`, received by the backend itself.
  Google's desktop client accepts any loopback port; Microsoft registers
  `http://localhost` and ignores the port.
- **Android:** Custom Tab plus an App Link or a reverse-DNS custom scheme for
  OneDrive. Google uses its Identity Services SDK.
- **Token storage:** Windows Credential Manager or DPAPI; on Android, an AES-GCM
  key in the Android Keystore with the ciphertext in DataStore.
  `EncryptedSharedPreferences` is deprecated.
- **The companion app uses the same OAuth registration** (same Google Cloud
  project, same Entra app). Both `drive.file` and the OneDrive app folder grant
  access per registered app, so a separate registration would not see the
  library.
- **The Android release signing key is permanent.** Google's Android client is
  bound to its SHA-1, and App Links to its SHA-256; a new key breaks sign-in for
  every user.

### 4. The library index lives in the user's storage

- The canonical index is a file inside the Spitifo folder (`index.json`: key,
  remote id, revision, title, artist, album, duration, size, format). The
  downloader writes it; the companion app and other devices read it, so nobody
  lists thousands of files to start.
- Writes are conditional on the file's revision (`If-Match` on Graph and Drive).
  On a conflict the writer re-reads, merges and retries.
- Each device keeps a local copy (SQLite) as a cache, refreshed when the index
  revision changes. Provider change feeds (Drive `changes`, Graph `delta`) can
  later detect files added outside Spitifo.

### 5. Playback speed

Playback must start almost instantly and never stall. These rules apply to every
provider:

1. **Local first.** A track already on the device, downloaded or cached, plays
   from disk.
2. **Prefetch.** While a track plays, the next one in the queue is fetched to the
   cache. Skipping ahead is then instant.
3. **Stream from the first bytes.** An uncached track starts playing as soon as
   the first range arrives; it is not downloaded completely first.
4. **Fast-start files.** An M4A file must have its index (`moov`) before the
   audio, or the player has to fetch the end of the file before it can play.
   Checked on 2026-10-16: files from the yt-dlp path already have `moov` first,
   but `downloader._ffmpeg_convert` writes it at the end (offset 3.8 MB in a
   3.9 MB test file). It needs `-movflags +faststart`. MP3 needs nothing.
5. **Range support end to end.** Seeking issues an HTTP range request.

How bytes reach the player:

- **Downloader app (WebView):** the local backend proxies `/api/audio`, adding
  the auth header and forwarding `Range`. An `<audio>` element cannot send an
  `Authorization` header, and Drive has no anonymous media URL.
- **Companion app:** if it is native, its player can send the auth header
  itself, or use OneDrive's pre-authenticated `downloadUrl`. OneDrive's URL
  expires after a short time, so it must be re-minted before seeking.
- A service worker adding the header was rejected: it cannot add the header to
  media requests reliably, and it moves the proxy somewhere more fragile.

### 6. Upload

- Tracks are still produced locally: download, convert, tag. Tagging and ffmpeg
  need a real file.
- The finished file is uploaded afterwards: as a single request below the
  provider's threshold (Drive 5 MB), and as a resumable session above it (Drive
  chunks of 256 KB multiples, Graph 320 KiB multiples). The session id is
  persisted, so a killed app resumes instead of starting over.
- The upload runs inside the same foreground service as the downloads on
  Android (ADR 0001).

### 7. Offline cache

- Streamed tracks go to an app-private cache directory: `cacheDir` on Android,
  `%LOCALAPPDATA%\Spitifo\cache` on Windows.
- Whole files only, keyed by remote id plus revision, with LRU eviction under a
  size budget. Tracks the user downloaded are never evicted.

### 8. Failure modes in the UI

| Failure | Signal | UI |
| --- | --- | --- |
| Token expired or revoked | `401`, `invalid_grant` | "Reconnect <provider>" |
| Quota full | Graph `507`, Drive `storageQuotaExceeded` | "Your <provider> is full"; keep the track local |
| No network | connection error | Play from local and cache; queue uploads |
| Rate limited | `429` / `403 rateLimitExceeded` with `Retry-After` | Retry silently with backoff |
| Index conflict | `412` | Re-read, merge, retry silently |

### 9. The `Storage` port

All access to finished files goes through one port. Local disk is the reference
adapter and keeps today's folder layout.

```python
@dataclass(frozen=True)
class StoredFile:
    key: str             # relative to the library root, e.g. "Artist/Artist - Title.mp3"
    size: int
    mtime: float
    etag: str | None = None   # provider revision; None for local disk


class Storage(Protocol):
    def list(self) -> Iterable[StoredFile]: ...
    def stat(self, key: str) -> StoredFile: ...
    def open_range(self, key: str, start: int = 0,
                   end: int | None = None) -> Iterator[bytes]: ...
    def put_file(self, key: str, src: Path) -> StoredFile: ...
    def delete(self, key: str) -> None: ...
```

- **Keys replace absolute paths.** Today `/api/library` returns host paths and
  `/api/audio?path=` takes them back (`main.py:463`, `main.py:474`,
  `frontend/src/main.jsx:2588`). They mean nothing on another device, and they
  reveal the host's folder layout.
- Key validation replaces the `is_relative_to` check in `/api/audio`: no key may
  address anything outside the library root.
- Downloading, tagging (`_write_tags`) and conversion (`_ffmpeg_convert`) stay
  on local temporary files. The port only covers where the finished file lives.
- Resumable uploads are internal to each cloud adapter's `put_file`.
- No method returns a direct URL yet. One is added if the companion app needs
  it.

Call sites that change in session 6: `downloader.download_track` and
`library_scan`, `ytdlp_source` (writes to a temporary folder and calls
`put_file`), `/api/library`, `/api/audio` (parses `Range`, answers `206`) and
the frontend's audio URL.

### Update (2026-10-17, session 6)

The port is implemented in `backend/app/storage/` with `LocalStorage` as the
reference adapter. Differences from the sketch above:

- `StoredFile` has an optional `duration`, because the library shows each
  track's length. `list()` fills it; `stat()` may leave it `None`, since
  `/api/audio` calls `stat()` on every seek and the local adapter would parse
  the file with mutagen each time. Cloud adapters will take it from
  `index.json`.
- `describe()` returns a human label for where the library is (the local path
  today), which the UI shows. `/api/health` and `/api/library` send it as
  `library`.
- `open_range`'s `end` is inclusive, like HTTP ranges.
- `validate_key` also rejects characters Windows does not allow in file names
  (`:*?"<>|`), the same set `safe_name` already strips, so every key can be a
  real file in the reference adapter. `list()` skips files whose names are not
  valid keys (possible on Linux or Android) instead of listing them and
  answering 404 later.
- Every download now works in its own temporary folder (`SPITIFO_TEMP_DIR`, or
  the system temp folder) and reaches the library only through `put_file`.
  yt-dlp writes there with `paths.home` and `paths.temp`.
- `/api/audio?key=` answers a single `Range` itself (`206`, `416` when
  unsatisfiable) and ignores malformed or multi-range headers with a full
  `200`. The old `path` parameter is gone, and responses carry `key` instead of
  absolute paths.
- Contract tests in `tests/test_storage_contract.py` run against every adapter
  listed in `ADAPTERS`.

### Update (2026-10-17, session 7): Google Drive is the first connector

The benchmark ran against a real Google Drive account with an 8.9 MB, 187 s
M4A file. Every run opened a new TLS connection, as an uncached play would.
"First audio" is the time until the first 64 KiB of a ranged read arrive.

| Where | First audio p50 / p95 | Seek to middle p50 / p95 | Full download | Largest gap |
| --- | --- | --- | --- | --- |
| PC, home connection (10 runs) | 772 / 872 ms | 759 / 1199 ms | 1.2 s, 58 Mbit/s | — |
| Pixel 9 Pro, Wi-Fi (5 runs) | 817 / 1006 ms | 880 / 1395 ms | 3.9 s, 19 Mbit/s | 327 ms |
| Pixel 9 Pro, 5G NSA (5 runs) | 920 / 972 ms | 861 / 1150 ms | 1.4 s, 49 Mbit/s | 12 ms |
| Pixel 9 Pro, 4G LTE (5 runs) | 875 / 928 ms | 895 / 943 ms | 1.5 s, 47 Mbit/s | 25 ms |

Every ranged response was a `206` with the requested `Content-Range`.

**Android sign-in works without a server.** The Identity Services
`AuthorizationClient`, asked for `drive.file`, shows the consent screen once.
After `am force-stop` and a relaunch it returns a new access token in 87–131 ms
with no UI. Kotlin hands only the access token to Python, and Python uses it
against Drive directly. No refresh token reaches the app, and none is needed:
the app asks `authorize()` again whenever the token expires. The probe that
measured this is `android/app/src/debug/kotlin/dev/spitifo/DriveProbeActivity.kt`
plus `backend/app/cloud/probe.py`, in debug builds only.

Every target is met, so Google Drive is the first connector and OneDrive was
not benchmarked. Consequences:

- The margin on first audio is thin: 0.8–0.9 s against a 1 s target, and most
  of it is DNS, TCP and TLS setup. The backend keeps one long-lived HTTP client
  per provider so plays after the first reuse the connection, and prefetching
  (section 5) keeps most plays off the network.
- `play-services-auth` depends on AndroidX, so `android.useAndroidX` is now
  `true`. The release app will use AndroidX once the connector ships.
- Google's desktop client requires its `client_secret` in the token exchange
  even with PKCE. It ships inside the binary and is not confidential.
- Registration steps and the commands to repeat the benchmark are in
  [docs/oauth-setup.md](../oauth-setup.md).

**Section 4 does not hold for Drive: there is no conditional write.** Drive API
v3 has no ETags (the v2 to v3 reference lists `Files.etag` as "n/a"), so
`index.json` cannot be written with `If-Match`. Instead each device writes only
its own index file, `index-<device id>.json`, in the `Spitifo` folder. A file
with a single writer cannot conflict. Readers merge every `index-*.json` per key:
the newest `updated_at` wins, and tombstones keep a deleted track from coming
back. This works on any provider; the conditional-write loop stays for providers
that support it. The device id is random, generated once and kept in the app's
data folder.

### Update (2026-10-18, session 8): OneDrive dropped

OneDrive is no longer planned. Microsoft requires an Entra tenant to register an
app for personal Microsoft accounts, and the maintainer could not open one: the
Azure sign-up needed for a tenant was rejected. Without a tenant there is no way
to register the app, so OneDrive was dropped on 2026-10-18.

Google Drive is the only connector for now. The attempt still left the codebase
better: `CloudStorage` (`backend/app/cloud/base.py`) is a provider-neutral base
class extracted from the Drive adapter. It holds everything that does not depend
on the provider (retries, the per-device index and its merge, the offline cache,
ranges and the quota), so adding a provider only means implementing the hooks at
the end of the class plus its OAuth `Provider`. Dropbox and WebDAV remain
options if a second connector is ever needed.

## Security note for session 3

On Android, any app on the phone can connect to `127.0.0.1:8000`. Android's
guidance is not to use localhost ports for sensitive IPC. Once the backend holds
cloud tokens, every request must carry a random secret generated at launch: the
shell gives it to the WebView, and the backend rejects requests without it. The
same applies on Windows.

## Consequences

- Session 3 adds the per-launch secret to the backend.
- Session 3 adds `-movflags +faststart` to the M4A encoder in
  `downloader._ffmpeg_convert`.
- Session 6 introduces the port and the local adapter, keyed by relative path.
- Session 7 starts with the provider benchmark, then implements the chosen
  provider: connect, upload, the index file, streaming through the backend, and
  disconnect.
- The companion app is a new item in the roadmap. It reuses the OAuth
  registration, the index file format and the playback rules above.

## Sources

The three research reports behind this ADR cite official documentation for
every claim. The key sources:

- RFC 8252, OAuth 2.0 for Native Apps: https://datatracker.ietf.org/doc/html/rfc8252
- Google unverified apps: https://support.google.com/cloud/answer/13464323
- Google verification not required: https://support.google.com/cloud/answer/13463073
- Google OAuth 2.0 and refresh tokens: https://developers.google.com/identity/protocols/oauth2
- Google, OAuth for desktop apps: https://developers.google.com/identity/protocols/oauth2/native-app
- Google Drive uploads: https://developers.google.com/drive/api/guides/manage-uploads
- Google Drive downloads (range): https://developers.google.com/drive/api/guides/manage-downloads
- Drive v2 to v3 reference (no `etag` on files): https://developers.google.com/workspace/drive/api/guides/v2-to-v3-reference
- Android authorization: https://developer.android.com/identity/authorization
- Android data security (localhost IPC): https://developer.android.com/topic/security/data
- AndroidX Security deprecation: https://developer.android.com/jetpack/androidx/releases/security
- Microsoft app folder: https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/special-folders-appfolder
- Microsoft reply URLs: https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
- Microsoft refresh tokens: https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
- Graph upload sessions: https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
- Graph download URL: https://learn.microsoft.com/en-us/graph/api/driveitem-get-content
- Dropbox developer guide: https://docs.dropboxapi.com/dropbox-api/docs/developer-resources/developer-guide
