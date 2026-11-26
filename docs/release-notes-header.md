<!--
  Prepended to every release's auto-generated notes by the `release` job
  (release.yml: "Write the release notes", gh api .../generate-notes piped
  into --notes-file). Keep it short: it's the first thing someone sees after
  clicking a download link, most of them not technical. The full version
  lives in the README's "Installation" section.
-->
## Installing spitifo

| Device | File |
| --- | --- |
| Android phone (arm64) | `spitifo-<version>-android.apk` |
| Windows PC | `spitifo-<version>-windows-setup.exe` |

- **Android** will ask to allow "unknown apps" the first time — **Settings →
  Security → Install unknown apps**, for the app you used to open the file.
  To update later, install the new APK **over** the old one; don't uninstall
  first.
- **Windows** will likely show "Windows protected your PC": that's
  SmartScreen's reputation system, not a sign the file is unsafe. Click **More
  info → Run anyway**. You can verify the download against `SHA256SUMS.txt`
  below.

Full steps and screenshots: the [README's Installation
section](https://github.com/asormar/spitifo#installation).

---

