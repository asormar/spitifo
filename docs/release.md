# Cutting a release

`.github/workflows/release.yml` builds the Windows installer and the Android
APK, verifies the APK signature and opens a **draft** GitHub release. The
maintainer reviews the draft and publishes it.

## Required secrets

Set these once on the repository (**Settings → Secrets and variables →
Actions**, or with `gh`). None of them is public, and CI never prints them.

| Secret | Value |
| --- | --- |
| `SPITIFO_GOOGLE_CLIENT_ID` | Google **desktop** client ID (Drive sign-in on Windows/Linux) |
| `SPITIFO_GOOGLE_CLIENT_SECRET` | Google **desktop** client secret |
| `ANDROID_KEYSTORE_BASE64` | `android/spitifo-release.jks`, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore's `storePassword` |
| `ANDROID_KEY_ALIAS` | the key's alias (`spitifo` in the example below) |
| `ANDROID_KEY_PASSWORD` | the key's `keyPassword` |

The Google desktop client comes from `docs/oauth-setup.md` (step 6, "Desktop
app") and is the same one in `backend/app/cloud/oauth_clients.json`. The
keystore passwords are the ones in `android/keystore.properties`.

### Setting them from the local files

From the repository root, in PowerShell. Every value is read from the files you
already have and piped into `gh` (without `--body`, `gh secret set` reads the
value from stdin), so no secret is typed, kept in the shell history or written
to a temporary file:

```powershell
$oauth = Get-Content backend\app\cloud\oauth_clients.json -Raw | ConvertFrom-Json
$ks = Get-Content android\keystore.properties -Raw | ConvertFrom-StringData

$oauth.google.client_id     | gh secret set SPITIFO_GOOGLE_CLIENT_ID
$oauth.google.client_secret | gh secret set SPITIFO_GOOGLE_CLIENT_SECRET
$ks.storePassword           | gh secret set ANDROID_KEYSTORE_PASSWORD
$ks.keyAlias                | gh secret set ANDROID_KEY_ALIAS
$ks.keyPassword             | gh secret set ANDROID_KEY_PASSWORD
[Convert]::ToBase64String([IO.File]::ReadAllBytes("android\spitifo-release.jks")) |
    gh secret set ANDROID_KEYSTORE_BASE64

Remove-Variable oauth, ks
gh secret list
```

`gh secret list` shows the six names (never the values). Avoid
`gh secret set NAME --body "<password>"`: it leaves the password in the shell
history. PowerShell has no `<` input redirection, so `gh secret set NAME < file`
does not work there either.

## Android OAuth client

Google matches an Android client by **package name + signing certificate**, so
the registration is tied to the release key, not to the code:

- package `dev.spitifo`
- SHA-1 `F5:2E:7E:03:40:6A:4C:AE:D6:35:09:68:E1:AF:EF:E6:BE:9F:75:1F`

That Android client must exist in the same Google Cloud project as the desktop
client (`docs/oauth-setup.md`). If the release keystore is ever replaced, both
the SHA-1 above and this registration change. CI enforces the fingerprint: the
`android` job runs `apksigner verify --print-certs` and fails unless the APK's
SHA-1 matches, because Drive sign-in breaks silently otherwise.

## Cutting a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

The tag drives everything: the `version` job strips the leading `v`, each build
job runs `python scripts/set_version.py <version>` (so nothing is committed from
CI), and the resulting artifacts are named `Spitifo-<version>-windows-x64-setup.exe`
and `Spitifo-<version>-android-arm64.apk`.

When both builds pass, the `release` job writes `SHA256SUMS.txt` and creates a
draft release at `https://github.com/<owner>/<repo>/releases`. Review the notes
and the assets, then publish the draft.

## Dry run

Actions → **release** → **Run workflow**, enter the version (`0.1.0`). A
`workflow_dispatch` run builds both artifacts and leaves them under the run's
Artifacts; it never creates or touches a release.

## Bundled QuickJS-ng

Both apps ship QuickJS-ng (`qjs`), the small JavaScript runtime yt-dlp runs to
solve YouTube's challenges, and pass the backend its absolute path through
`SPITIFO_QJS`. The binary is downloaded at build time and **pinned by SHA-256**,
never committed: `desktop/build.ps1` (`Get-QuickJs`) verifies
`qjs-windows-x86_64.exe` and copies it to `desktop/qjs/qjs.exe`, and
`android/app/build.gradle.kts` (`downloadQuickJs`) does the same for
`qjs-linux-aarch64`, packaged as `libqjs.so`. Both builds fail on a hash
mismatch. To bump it, change the version and **both** hashes in those two files,
plus the `quickjs-<version>` suffix of the `desktop/.cache` cache key in
`.github/workflows/release.yml` (the upstream release publishes no checksums
file, so the pinned hashes are the only reference).

## Versions

`scripts/set_version.py X.Y.Z` rewrites the version in `desktop/package.json`,
`desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml` and
`desktop/src-tauri/Cargo.lock`, plus `versionName`/`versionCode` in
`android/app/build.gradle.kts` (`versionCode = major*10000 + minor*100 + patch`).
Run it before a local build if you want the local artifacts to carry the tag's
version; CI does it for you.
