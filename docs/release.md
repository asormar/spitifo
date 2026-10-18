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
app"). The keystore passwords are the ones written into
`android/keystore.properties` when the key was created.

### Encoding the keystore

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("android\spitifo-release.jks")) |
    Set-Content keystore.b64
gh secret set ANDROID_KEYSTORE_BASE64 < keystore.b64
Remove-Item keystore.b64
```

The intermediate file exists so the secret is never typed or pasted by hand;
delete it once the secret is set. Short values can be set directly instead:

```bash
gh secret set SPITIFO_GOOGLE_CLIENT_ID --body "1234.apps.googleusercontent.com"
gh secret set SPITIFO_GOOGLE_CLIENT_SECRET --body "GOCSPX-..."
gh secret set ANDROID_KEYSTORE_PASSWORD --body "<storePassword>"
gh secret set ANDROID_KEY_ALIAS --body "spitifo"
gh secret set ANDROID_KEY_PASSWORD --body "<keyPassword>"
```

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

## Versions

`scripts/set_version.py X.Y.Z` rewrites the version in `desktop/package.json`,
`desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml` and
`desktop/src-tauri/Cargo.lock`, plus `versionName`/`versionCode` in
`android/app/build.gradle.kts` (`versionCode = major*10000 + minor*100 + patch`).
Run it before a local build if you want the local artifacts to carry the tag's
version; CI does it for you.
