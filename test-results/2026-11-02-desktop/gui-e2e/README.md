# Installed Linux app, end to end (synthetic, isolated)

Ubuntu 24.04 container: debug `.deb` installed with apt, Xvfb display, private
PulseAudio with a virtual microphone (330 Hz tone) and virtual speakers (550 Hz
tone), gnome-keyring (Secret Service), D-Bus session. Real local `cap-server`
(this worktree) on 127.0.0.1:8797 with a fresh database, and a mock Calari that
issues a pairing code and verifies delivery signatures. Debug build pointed at
it with `CAP_DEV_SERVER_URL` (release builds cannot do this).

1. `01-launched.png`: app starts; no server field, no sign-in, extension "coming soon".
2. `deep-link.txt`: the app registered itself as the `cap://` handler
   (`cap-desktop-handler.desktop`); `gio open "cap://pair?code=…&mode=audio&title=Synthetic kickoff"`
   reached the running app (single instance).
3. `02-note-taker-link.png`: "Add note taker?" prompt; nothing recorded and no
   meeting created on the server until the user clicks.
4. Click "Start recording" (xdotool): pairs with the code, starts recording.
   `03-recording.png`: "Recording for Synthetic Client Ltd."; FFmpeg captures
   Pulse `default` (microphone) + `@DEFAULT_MONITOR@` (speakers).
   `keyring.txt`: device and meeting tokens in the keyring, not in plain files.
5. Click "Stop and send to Calari". `05-sent.png`: "Sent to Calari".
   `delivery-summary.json`: signed delivery verified, title from the link,
   `user_stopped`, not partial, ~24 s.
   `audio-content.txt`: the stored audio holds both the microphone and the
   speakers tone; control frequencies are silent.

Bug found and fixed by this run: the first attempt paired but Start never
recorded. The app panicked ("Cannot drop a runtime in a context where
blocking is not allowed"): the recorder's blocking HTTP client was created in
an async command. It is now created and dropped only on a blocking thread
(`apps/desktop/src-tauri/src/meeting.rs`). Same code path on Windows.

Not covered: real microphones/speakers, a real browser opening the link, Wayland,
Windows/macOS GUI.

## Final run on source 4b93215 (after keyring and 0700 fixes)

Screenshots, `delivery-summary.json` and `audio-content.txt` above are from
this run, with the DEBUG TEST package (sha256
76541c752edfeb3f956b218fab12a5979c2af0b7d9cd01024d6f1ea6b84f7bb1, never for
publication). No meeting existed before the click; FFmpeg recorded Pulse
default + speakers monitor; 2 keyring items; meeting folder mode 700
(`meeting-folder-modes.txt`); no panics; signed delivery verified, title from
the link, user_stopped, not partial; both tones present (838/837), controls
silent. The production package is described in `../final-linux-deb.txt`.
