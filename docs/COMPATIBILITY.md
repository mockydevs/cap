# Compatibility matrix

This is the supported launch matrix. Each row must be exercised against staging before a release; “supported” describes the intended product contract, not evidence that the current machine tested that device.

| Surface               | Minimum target                                  | Capture expectations                                                          | Release verification                                                         |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Chrome / Edge desktop | Current and previous major, Windows/macOS/Linux | Screen/window/tab and microphone; system audio where the browser exposes it   | Record, pause/resume, recover upload, process, share, seek transcript        |
| Safari desktop        | Current and previous major, macOS               | Screen/window and microphone; browser-dependent system audio                  | Same flow, plus permission denial/retry                                      |
| Firefox desktop       | Current and previous major                      | Screen/window and microphone; MediaRecorder codec support may differ          | Same flow with accepted codec confirmed by FFprobe                           |
| Mobile browsers       | Current Safari iOS and Chrome Android           | Playback, comments, library, sharing; screen capture is not promised          | Authentication, playback, captions, comments                                 |
| Cap desktop Windows   | Windows 10 22H2+ / Windows 11                   | Screen, microphone, supported system audio, global shortcut, offline recovery | Signed installer, permissions, sleep/wake, crash recovery, background upload |
| Cap desktop macOS     | macOS 13+ on Intel and Apple Silicon            | Screen Recording and Microphone permissions, supported system audio           | Signed/notarized universal release, permission reset, crash recovery         |
| Cap desktop Linux     | Supported Ubuntu LTS on X11 and Wayland         | Portal/PipeWire capture where available, microphone                           | AppImage/deb install, portal denial, display-server matrix, crash recovery   |

Desktop release CI builds platform artifacts, but signing, notarization, auto-update publication, and real-device acceptance require the corresponding platform credentials and runners. See `docs/DESKTOP.md`.
