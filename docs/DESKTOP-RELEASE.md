# Desktop release

`.github/workflows/desktop-release.yml` builds, checks and signs the Linux
`.deb` and Windows `.exe` installers and uploads them, with a download
manifest, as workflow artifacts. It never publishes a GitHub release; the
release owner reviews the artifacts and copies them to the download server.

## Settings (names only)

| Kind     | Name                                                              | Value                                           |
| -------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| Variable | `CAP_DEFAULT_SERVER_URL`                                          | `https://meetings.calari.tech` (required)       |
| Variable | `TAURI_UPDATER_PUBKEY`                                            | public half of the updater key (optional)       |
| Variable | `CAP_UPDATER_ENDPOINT`                                            | `https://cap.calari.tech/downloads/latest.json` |
| Secret   | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater key; unused until updates are turned on |

All are set on `mockydevs/cap` (2026-11-02). The updater key is a new,
dedicated key; its private half and password live only in the GitHub secrets
and the release owner's protected store. The key that used to be in
`tauri.conf.json` was dropped because its private half was unavailable; no
desktop release was ever signed with it.

**Updates are off for the first releases.** Installers are direct downloads.
Tauri CLI 2.11 signs update files without the version, and the app requires a
signed version (anti-downgrade) and will not relax that, so no update payload
is built. The pubkey and endpoint are embedded when set, so a later release
with a version-bound signer can be offered; until the server publishes
`latest.json`, the app shows no update. There is no unsigned or
skip-verification fallback.

The macOS lane runs only with `include_mac=true` and needs `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD` and `APPLE_TEAM_ID`. Mac signing is deferred, so DMGs stay
`signing_pending` in the manifest.

## Running it

```bash
gh workflow run desktop-release.yml --repo mockydevs/cap --ref <branch>
gh run download <run-id> --repo mockydevs/cap --name cap-desktop-<version>
```

The `cap-desktop-<version>` artifact holds:

- `cap-desktop_<version>_linux-x86_64.deb`
- `cap-desktop_<version>_windows-x86_64-setup.exe`
- `manifest.json`: download hub v1, only `schema_version` and
  `artifacts`. An available entry has platform, version, filename, bytes,
  SHA-256 and status; a `pending` or `signing_pending` entry has only
  platform and status.
- `cap-desktop-receipt.json`: version, commit and statuses for the record.
- `SHA256SUMS`
- `updater-manifest.json` only once signed update payloads exist (per Tauri
  platform key, e.g. `windows-x86_64-nsis` and `linux-x86_64-deb`: payload
  and `.sig` with filename, bytes and SHA-256).

Copy the installers to the download folder and check every file's size and
SHA-256 against the manifest before serving it. Users update by downloading
the new installer.

Trust: the Windows installer is not Authenticode-signed, so Windows
SmartScreen warns on first run. The `.deb` is not GPG-signed; users should
download it only from the Cap download page over https.

## What the workflow checks

- Linux: desktop and recorder tests, including real FFmpeg capture uploaded
  to the Rust server and delivered to a mock Calari; microphone plus speaker
  capture through a private PulseAudio with synthetic tones
  (`scripts/desktop/pulse-capture-smoke.sh`); package name, version,
  `amd64` and the `ffmpeg` dependency; an x86-64 binary with the server baked
  in; install and removal on a clean Ubuntu 24.04.
- Windows: the pinned FFmpeg's checksum (`scripts/desktop/fetch-windows-ffmpeg.py`),
  its devices and encoders; synthetic recordings with the app's own encoder
  flags (Opus audio segments, VP8 meeting video, OpenH264 + AAC screen MP4,
  plus a gdigrab desktop capture where the runner has a desktop); recorder
  unit tests on Windows, including the loopback pipe and its stop; x86-64 installer and app;
  silent install with `ffmpeg.exe` and its licence notice next to the app;
  silent uninstall.

## Known limits

- The Windows installer is not Authenticode-signed, so SmartScreen warns on
  first run until a code-signing certificate is added.
- GitHub's Windows runners have no sound device, so WASAPI loopback capture of
  real sound and a full recording on Windows still need a check on a real PC.
- No in-app updates yet (see above); users install new versions by hand.
