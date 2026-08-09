# Desktop application

Cap Desktop is a Tauri 2 application with a Rust recorder and React control surface. It stores every recording under the operating system's application-data directory and atomically updates `project.json` before capture or upload state changes. An interrupted `RECORDING` project is recovered as `RECOVERABLE` at the next launch.

## Platform support

- Windows 10/11: desktop and region capture through FFmpeg `gdigrab`; microphone through DirectShow; loopback audio uses the packaged virtual-audio capture device.
- macOS 12.3+: display capture through AVFoundation. Screen Recording, Camera, and Microphone permissions must be granted in System Settings. System audio requires the ScreenCaptureKit-enabled media runtime.
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

The release workflow builds Apple Silicon macOS, Intel macOS, Windows, and Linux artifacts and creates a draft GitHub release. Test capture permissions, audio routing, crash recovery, upload resume, installation, signature verification, and update rollback on physical machines before publishing it.
