# Desktop release

`.github/workflows/desktop-release.yml` builds, checks and signs the Linux
`.deb` and Windows `.exe` installers and uploads them, with a download
manifest, as workflow artifacts. It never publishes a GitHub release; the
release owner reviews the artifacts and copies them to the download server.

## Settings (names only)

| Kind     | Name                                 | Value                                           |
| -------- | ------------------------------------ | ----------------------------------------------- |
| Secret   | `TAURI_SIGNING_PRIVATE_KEY`          | updater signing key (private half)              |
| Secret   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password                                    |
| Variable | `TAURI_UPDATER_PUBKEY`               | updater signing key (public half)               |
| Variable | `CAP_DEFAULT_SERVER_URL`             | `https://meetings.calari.tech`                  |
| Variable | `CAP_UPDATER_ENDPOINT`               | `https://cap.calari.tech/downloads/latest.json` |

All five are set on `mockydevs/cap` (2026-11-02). The updater key is a new,
dedicated key; its private half and password live only in the GitHub secrets
and the release owner's protected store, never in git or logs. The key that
used to be in `tauri.conf.json` was dropped because its private half was
unavailable; no desktop release was ever signed with it. There is no unsigned
or skip-verification fallback.

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
- `cap-desktop_<version>_windows-x86_64-setup.exe` and its updater `.sig`
- `cap-desktop-manifest.json`: download hub v1, only `schema_version` and
  `artifacts`. An available entry has platform, version, filename, bytes,
  SHA-256 and status; a `pending` or `signing_pending` entry has only
  platform and status.
- `updater-manifest.json` (only when a signed update payload exists): per
  Tauri updater platform key, currently only `windows-x86_64-nsis`, the
  payload (the NSIS installer itself) and its `.sig` (a text file holding the
  base64 minisign signature) with filename, bytes and SHA-256. The download
  server builds `latest.json` from it with its own trusted URLs.
- `cap-desktop-receipt.json`: version, commit and statuses for the record.
- `SHA256SUMS`

Copy the installers (and the Windows `.sig`) to the download folder and check
every file's size and SHA-256 against the manifests before serving it.

Updates: Windows offers a signed update and installs it after the user clicks
"Install and restart" (never while recording). Linux is updated by
downloading and installing the new `.deb`; the app does not check for
updates there. Until the server publishes `latest.json`, the Windows app
shows no update and never claims to be up to date.

Trust: the updater `.sig` only lets an installed Cap verify an update. It is
not Authenticode: the Windows installer itself is unsigned, so Windows
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
- The Windows build fails without the updater signing key, so every Windows
  update payload is signed.

## Known limits

- The Windows installer is not Authenticode-signed, so SmartScreen warns on
  first run until a code-signing certificate is added.
- GitHub's Windows runners have no sound device, so WASAPI loopback capture of
  real sound and a full recording on Windows still need a check on a real PC.
- Installed apps update themselves only once a release built with the new
  updater key is installed.
