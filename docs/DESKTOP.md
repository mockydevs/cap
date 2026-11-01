# Desktop application

Cap Desktop is a Tauri 2 application with a Rust recorder and React control surface. It stores every recording under the operating system's application-data directory and atomically updates `project.json` before capture or upload state changes. An interrupted `RECORDING` project is recovered as `RECOVERABLE` at the next launch.

## Platform support

- Windows 10/11: desktop and region capture through FFmpeg `gdigrab`; microphone through DirectShow. The computer's own sound (the other people in a call) is recorded natively with WASAPI loopback from the default speakers or headphones (`crates/meeting-recorder/src/system_audio.rs`), so no "Stereo Mix" or virtual audio driver is needed. The installer bundles a pinned LGPL FFmpeg next to the app.
- macOS 12.3+: display capture through AVFoundation. Screen Recording, Camera, and Microphone permissions must be granted in System Settings. Microphone audio is captured by ffmpeg's `avfoundation` input, same as video.
  - System audio _with no microphone selected_ is captured by a separate helper process, `macos/sck-audio-capture` (Swift, `ScreenCaptureKit`), which `capture.rs` spawns alongside ffmpeg and feeds into it as a second input over a named pipe (raw `f32le`, 48 kHz, stereo). It requires macOS 13.0+ and a Screen Recording grant; it is compiled at build time by `build.rs` only when `swiftc` is available and only when building for macOS. **This path is new and has not been built, run, or tested on real macOS hardware** — it was written from ScreenCaptureKit documentation and public sample code by someone without access to macOS/Xcode. Before shipping it: build on a real Mac with Xcode, verify `bundle.macOS.resources` actually places `sck-audio-capture` where `capture.rs` looks for it, verify the TCC Screen Recording permission grant covers this spawned helper (it may need its own separate grant — unconfirmed), verify pause/resume behavior, and verify a universal (Apple Silicon + Intel) build actually produces a working `lipo`'d helper binary.
- Linux: microphone and the speakers' monitor through PipeWire/PulseAudio (the `.deb` depends on the distribution's `ffmpeg`). Screen capture uses X11 `x11grab`; on a Wayland session it only sees X11 (XWayland) windows, so audio meeting notes are the supported mode there.

The application checks capabilities at runtime and returns an actionable error when a host lacks a required portal, permission, device, or media runtime. It never silently records a synthetic source.

## Local development

Install Rust stable, the Tauri prerequisites for your operating system, FFmpeg, Node 22, and pnpm 10. Then run:

```bash
pnpm install
pnpm --filter @cap/desktop desktop:dev
```

`Ctrl/Cmd+Shift+R` controls start/stop and `Ctrl/Cmd+Shift+P` controls pause/resume. Source MP4 files use fragmented MP4 output so completed fragments remain recoverable after a crash.

## Server and sign-in

A release build talks to exactly one Cap server, fixed at build time by `CAP_DEFAULT_SERVER_URL` (`https://meetings.calari.tech` for Calari). The build fails if it is missing, not https, or local. The app has no server field, no Cap account and no password: it pairs with a one-time code from Calari (typed in, or from an "Add note taker" `cap://pair` link, which can pre-fill the code but never chooses the server or starts recording by itself). The device token and each meeting's own token live in Keychain, Windows Credential Manager or Secret Service. Debug builds can point at a local server with `CAP_DEV_SERVER_URL=http://127.0.0.1:8787`.

Screen recordings made with the "New recording" card stay on the device.

## Releases

See [DESKTOP-RELEASE.md](DESKTOP-RELEASE.md).
