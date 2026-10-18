# OAuth registration for the cloud connector

One-time setup of the OAuth registration that roadmap session 7 needs for its
benchmark (ADR 0002, section 2). The registration is permanent: the downloader
and the companion app share it (ADR 0002, section 3).

Values that go into the registration:

| Value | |
| --- | --- |
| Android package name | `dev.spitifo` |
| Release certificate SHA-1 | `F5:2E:7E:03:40:6A:4C:AE:D6:35:09:68:E1:AF:EF:E6:BE:9F:75:1F` |
| Debug certificate SHA-1 | `C6:3C:14:41:C1:EB:D9:4E:1F:CA:F4:61:2A:D6:49:41:15:3C:0F:07` |

The fingerprints come from `apksigner verify --print-certs` on the release and
debug APKs. The release key is `android/spitifo-release.jks`; if it is ever
replaced, the registration below must be updated.

## Google Cloud (Google Drive)

1. Open <https://console.cloud.google.com/>, sign in with the Google account
   that will own the app, and create a project named `Spitifo`.
2. **APIs & Services → Library**: search for "Google Drive API" and enable it.
3. **Google Auth Platform → Branding**: app name `Spitifo`, your support email,
   your developer contact email. Leave the logo empty for now: a logo triggers
   brand verification.
4. **Google Auth Platform → Audience**: user type **External**. Then press
   **Publish app** so the status is **In production**. In "Testing", refresh
   tokens expire after 7 days and the benchmark would measure the wrong thing.
   With only the `drive.file` scope, production does not require app
   verification.
5. **Google Auth Platform → Data access → Add or remove scopes**: add
   `https://www.googleapis.com/auth/drive.file` and save. Add nothing else.
6. **Google Auth Platform → Clients → Create client**:
   - Type **Desktop app**, name `Spitifo desktop`. Copy the **client ID** and
     the **client secret**. Google requires the secret in the token exchange
     even with PKCE; for a desktop app it is not confidential and ships inside
     the binary.
   - Type **Android**, name `Spitifo Android release`, package `dev.spitifo`,
     SHA-1 = release SHA-1 above.
   - Type **Android**, name `Spitifo Android debug`, package `dev.spitifo`,
     SHA-1 = debug SHA-1 above. Google may refuse two Android clients with the
     same package in one project; if so, skip the debug one and test with the
     release build.
   - The Android clients have no ID to copy: Google matches the app by package
     and certificate.

## Handing the values to the code

Neither value is secret, so they can live in the repository once the benchmark
picks a provider. Until then the backend reads them from the environment:

| Variable | Value |
| --- | --- |
| `SPITIFO_GOOGLE_CLIENT_ID` | Google desktop client ID |
| `SPITIFO_GOOGLE_CLIENT_SECRET` | Google desktop client secret |

## Running the provider benchmark

With the environment variables set, run the PC benchmark against Google Drive
(ADR 0002, section 2). The first run opens the browser for consent and stores
the tokens under `bench-<provider>`; later runs reuse them from disk, which is
the PC proxy for "sign-in survives a restart":

```
python -m backend.app.cloud.bench google --file track.m4a --runs 10
```

The command uploads the file once to the app's visible folder (`Spitifo`) and
reuses it when the size matches.
It then measures, per run, how long until the first byte and until the first
64 KiB chunk of a ranged read, the same for a seek to the middle, and a full
download. Two targets decide the winner: **first audio p50 < 1 s** (measured as
the first chunk) and **seek to the middle p50 < 1 s**; a **throughput ratio >= 2**
against the file's own bitrate means stalls are unlikely on 4G. `--json` writes
every raw sample for the notes.
