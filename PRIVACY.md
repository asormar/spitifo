# Spitifo privacy policy

Last updated: 2026-10-17

Spitifo is an open-source music app that runs entirely on your own device. It
has no server of its own: the maintainers never receive, store or see your
data.

## What Spitifo stores, and where

- **Your music library** is stored on your device. If you connect a cloud
  storage account (Google Drive or OneDrive), Spitifo also stores your tracks
  and a library index file (`index.json`) in a folder of that account named
  `Spitifo`.
- **Sign-in tokens** for a connected cloud account are stored only on your
  device, encrypted with the operating system's protection (Windows DPAPI, the
  Android Keystore).
- **Settings and an offline cache** of recently played tracks are stored only on
  your device.

Nothing is sent to the Spitifo maintainers or to any third party.

## Google user data

When you connect Google Drive, Spitifo requests only the
`https://www.googleapis.com/auth/drive.file` scope. With it, Spitifo can see and
change only the files it created itself (your tracks and its index), not any
other file in your Drive.

Spitifo uses this access only to upload, list, play and delete your music
library at your request. It does not use Google user data for advertising, does
not sell it, does not transfer it to anyone, and no person reads it.

Spitifo's use and transfer of information received from Google APIs adheres to
the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Microsoft user data

When you connect OneDrive, Spitifo requests access only to its own app folder
(`Apps/Spitifo`) and uses it in the same way, for the same purposes and with the
same limits as described for Google Drive above.

## Disconnecting and deleting data

- Disconnecting a cloud account in Spitifo deletes its tokens from your device.
- You can also revoke access at any time: for Google at
  <https://myaccount.google.com/permissions>, for Microsoft at
  <https://account.live.com/consent/Manage>.
- Uninstalling Spitifo deletes everything it stored on your device. Files in
  your cloud folder stay in your account until you delete them.

## Contact

Questions about this policy: open an issue at
<https://github.com/asormar/spitifo/issues>.
