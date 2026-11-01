# Desktop release

`.github/workflows/desktop-release.yml` builds, checks and signs the Linux
`.deb` and Windows `.exe` installers and uploads them, with a download
manifest, as workflow artifacts. It never publishes a GitHub release; the
release owner reviews the artifacts and copies them to the download server.

## Settings (names only)

| Kind     | Name                                 | Value                                                                  |
| -------- | ------------------------------------ | ---------------------------------------------------------------------- |
| Secret   | `TAURI_SIGNING_PRIVATE_KEY`          | updater signing key (private half)                                     |
| Secret   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password                                                           |
| Variable | `TAURI_UPDATER_PUBKEY`               | updater signing key (public half)                                      |
| Variable | `CAP_DEFAULT_SERVER_URL`             | `https://meetings.calari.tech`                                         |
| Variable | `CAP_UPDATER_ENDPOINT`               | `https://<host>/downloads/latest.json` (where `latest.json` is served) |

Create the updater key once, offline, and never commit or paste the private
half: `pnpm --filter @cap/desktop tauri signer generate -w cap-updater.key`
(it asks for a password). The key previously named in `tauri.conf.json` was
removed because no one could confirm who holds its private half; no release
was ever signed with it, so nothing installed depends on it.

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

- `cap-desktop_<version>_linux-x86_64.deb` and `.sig`
- `cap-desktop_<version>_windows-x86_64-setup.exe` and `.sig`
- `cap-desktop-manifest.json`: download hub v1, only `schema_version` and
  `artifacts`. An available entry has platform, version, filename, bytes,
  SHA-256 and status; a `pending` or `signing_pending` entry has only
  platform and status.
- `updater-manifest.json`: per Tauri updater platform key
  (`windows-x86_64-nsis`, `linux-x86_64-deb`), the payload (the installer
  itself) and its `.sig` with filename, bytes and SHA-256. The download
  server builds `latest.json` from it with its own trusted URLs.
- `cap-desktop-receipt.json`: version, commit and statuses for the record.
- `SHA256SUMS`

Copy the installers and `.sig` files to the download folder and check every
file's size and SHA-256 against the manifests before serving it. Updates on
Windows install silently after the user clicks "Install and restart"; on
Linux the updater installs the new `.deb` with `pkexec dpkg -i`, so it asks
for the user's administrator password. Until the server publishes
`latest.json`, the app shows no update and never claims to be up to date.

## What the workflow checks

- Linux: desktop and recorder tests, including real FFmpeg capture uploaded
  to the Rust server and delivered to a mock Calari; microphone plus speaker
  capture through a private PulseAudio with synthetic tones
  (`scripts/desktop/pulse-capture-smoke.sh`); package name, version,
  `amd64` and the `ffmpeg` dependency; an x86-64 binary with the server baked
  in; install and removal on a clean Ubuntu 24.04.
- Windows: the pinned FFmpeg's checksum (`scripts/desktop/fetch-windows-ffmpeg.py`),
  its devices and encoders, a synthetic recording into Opus segments; recorder
  unit tests on Windows, including the loopback pipe; x86-64 installer and app;
  silent install with `ffmpeg.exe` and its licence notice next to the app;
  silent uninstall.
- Every available installer must have an updater signature, or the run fails.

## Known limits

- The Windows installer is not Authenticode-signed, so SmartScreen warns on
  first run until a code-signing certificate is added.
- GitHub's Windows runners have no sound device, so WASAPI loopback capture of
  real sound and a full recording on Windows still need a check on a real PC.
- Installed apps update themselves only once a release built with the new
  updater key is installed.
