# Desktop application

Cap Desktop is a Tauri 2 application with a Rust recorder and React control surface. It stores every recording under the operating system's application-data directory and atomically updates `project.json` before capture or upload state changes. An interrupted `RECORDING` project is recovered as `RECOVERABLE` at the next launch.

## Platform support

- Windows 10/11: desktop and region capture through FFmpeg `gdigrab`; microphone through DirectShow; loopback audio uses the packaged virtual-audio capture device.
- macOS 12.3+: display capture through AVFoundation. Screen Recording, Camera, and Microphone permissions must be granted in System Settings. Microphone audio is captured by ffmpeg's `avfoundation` input, same as video.
  - System audio _with no microphone selected_ is captured by a separate helper process, `macos/sck-audio-capture` (Swift, `ScreenCaptureKit`), which `capture.rs` spawns alongside ffmpeg and feeds into it as a second input over a named pipe (raw `f32le`, 48 kHz, stereo). It requires macOS 13.0+ and a Screen Recording grant; it is compiled at build time by `build.rs` only when `swiftc` is available and only when building for macOS. **This path is new and has not been built, run, or tested on real macOS hardware** — it was written from ScreenCaptureKit documentation and public sample code by someone without access to macOS/Xcode. Before shipping it: build on a real Mac with Xcode, verify `bundle.macOS.resources` actually places `sck-audio-capture` where `capture.rs` looks for it, verify the TCC Screen Recording permission grant covers this spawned helper (it may need its own separate grant — unconfirmed), verify pause/resume behavior, and verify a universal (Apple Silicon + Intel) build actually produces a working `lipo`'d helper binary.
- Linux: X11 display/window-region capture through `x11grab`; microphone and monitor audio through PipeWire/PulseAudio. Wayland requires PipeWire and `xdg-desktop-portal` permission mediation.

The application checks capabilities at runtime and returns an actionable error when a host lacks a required portal, permission, device, or media runtime. It never silently records a synthetic source.

## Local development

Install Rust stable, the Tauri prerequisites for your operating system, FFmpeg, Node 22, and pnpm 10. Then run:

```bash
pnpm install
pnpm --filter @cap/desktop desktop:dev
```

`Ctrl/Cmd+Shift+R` controls start/stop and `Ctrl/Cmd+Shift+P` controls pause/resume. Source MP4 files use fragmented MP4 output so completed fragments remain recoverable after a crash.

## Authentication and uploads

The native login endpoint returns an opaque 30-day application session. Google sign-in opens the operating system browser, binds a random loopback port, and uses Authorization Code with S256 PKCE and state validation; Google credentials are never entered into the Tauri webview. Rust stores the server URL and resulting Cap token in Keychain, Windows Credential Manager, or Secret Service. AWS credentials and object keys never reach the application. Uploads use the same checksum-bound, short-lived multipart signing endpoints as browser uploads and persist every ETag before proceeding.

## Signing and releases

The checked-in updater public key verifies update artifacts. Store its corresponding private key only in the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub secrets. Configure the Apple signing/notarization secrets named in `desktop-release.yml`; configure the Windows runner with the organization's trusted code-signing identity before publishing a non-draft release. Never replace the updater key without an explicit key-rotation release plan.

The release workflow builds one easy-install package per platform — `.dmg` (Apple Silicon and Intel macOS), `.deb` (Linux), and an NSIS `.exe` installer (Windows) — and publishes them directly to a GitHub release (not a draft: `releaseDraft: false`). Push a tag containing a semver pre-release identifier (e.g. `desktop-v0.2.0-beta.1`) to publish as a pre-release instead — pre-releases are excluded from "latest" and therefore from the auto-updater until a plain version tag follows. Test capture permissions, audio routing, crash recovery, upload resume, installation, signature verification, and update rollback on physical machines before tagging a non-pre-release version.
