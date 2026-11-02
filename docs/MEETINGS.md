# Meeting notes (Rust pipeline)

Cap records a meeting as audio or video, transcribes it on Cap's own server,
and delivers the transcript to the right client in the Calari portal. The
contract with Calari is in [integrations/calari/CONTRACT.md](integrations/calari/CONTRACT.md);
the plan for moving all of Cap to Rust is [ADR 0004](decisions/0004-rust-rewrite.md).

## Pieces

| Piece                           | Where                     | Language                         |
| ------------------------------- | ------------------------- | -------------------------------- |
| Protocol, signing, fixtures     | `crates/meeting-protocol` | Rust                             |
| End/idle detector               | `crates/meeting-detector` | Rust (also WASM for Chrome)      |
| Server (pairing, uploads, jobs) | `crates/cap-server`       | Rust                             |
| Desktop capture engine          | `crates/meeting-recorder` | Rust (drives FFmpeg)             |
| Desktop app                     | `apps/desktop`            | Rust (Tauri); window still React |
| Chrome extension                | `apps/extension`          | JS glue + Rust detector (WASM)   |
| Landing page                    | `apps/site`               | static HTML/CSS                  |

Chrome only runs extensions as JavaScript with a JSON manifest, so the
extension keeps a thin JS layer for `chrome.*`, `MediaRecorder` and
`getUserMedia`. FFmpeg (C) stays an external process for encoding.

## How a meeting gets to Calari

1. Calari's server asks Cap for a pairing code after Clare finishes `/intake`
   (or from a client page, or for an internal meeting). The code is shown with
   an **Add note taker** button (`cap://pair?code=…&mode=audio|video`).
2. The desktop app opens from that button and asks to start, or Clare types
   the code into it. In Chrome, staff click **Sign in with Calari** in the
   extension: they sign in on Calari's own page with their portal account and
   pick the client or an internal meeting; no separate Cap password exists.
3. The device records 30-second standalone chunks and uploads each one as it
   finishes. Chunks stay on disk (desktop) or in IndexedDB (extension) until
   the server confirms them.
4. Recording stops on: Stop, the call ending (Meet), the tab or watched window
   closing, the audio device disappearing, a long silence (6 min, then a
   warning, then 3 more min), or 4 hours. Normal pauses in conversation never
   stop it.
5. The server transcribes each chunk once (cached, so retries never repeat
   work), assembles the ordered transcript and sends one signed, idempotent
   delivery to Calari. Calari's own worker summarizes it and works out whether
   it was a client meeting or an internal briefing/delegation.

If the app crashes or the computer loses power, the next launch uploads what
was saved and finalizes the meeting as `interrupted`. If a device never comes
back, the server finalizes it after 6 hours with the audio it received.

## What can be recorded

| Meeting                           | How                                                                   | Limits                                                                            |
| --------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Google Meet in Chrome             | Extension (tab audio + your mic), or desktop app (system audio + mic) | Extension needs one click to start; "call ended" detection reads Meet's page text |
| Zoom / Teams / Webex in a browser | Extension                                                             | No end-of-call detection; tab close, navigation away and silence still stop it    |
| Zoom / Teams desktop apps         | Desktop app, optionally watching the meeting window title             | Needs system-audio capture on the OS (below)                                      |
| Phone or in-person                | Desktop app, microphone only                                          | —                                                                                 |

Cap never joins a meeting as a bot, and nothing records without a visible
indicator (Chrome's tab-capture indicator and badge, or the desktop window).

### Platform notes

- **Linux**: microphone and system audio through PulseAudio/PipeWire
  (`@DEFAULT_MONITOR@`); video through X11. Tested here with real FFmpeg and
  synthetic sources.
- **Windows**: microphone through DirectShow; system audio needs the
  `virtual-audio-capturer` device. Compiles in CI; **not tested on Windows
  hardware**.
- **macOS**: meeting mode records the microphone only, because the
  ScreenCaptureKit system-audio helper has never been built or run on a Mac
  (see [DESKTOP.md](DESKTOP.md)). Video meeting mode is not available on macOS
  yet. **Not tested on macOS hardware.**

## Calendar ("Include Cap")

In a Google Calendar event, the extension adds an **Include Cap?** choice
that writes `[Cap: record audio]` or `[Cap: record video]` into the
description, so guests can see the meeting will be recorded. Typing that line
by hand works too. With Google Calendar connected (read-only), Cap reminds
you when the meeting starts and you start recording with one click or
Alt+Shift+R. Chrome does not let an extension start capturing a tab on its
own, so the browser path cannot be fully automatic.

Setup needed once: a Google OAuth client of type **Chrome extension** for the
extension's ID, with the `calendar.events.readonly` scope, placed in
`apps/extension/manifest.json` (`oauth2.client_id`).

## Meetings library

Calari staff open `https://meetings.calari.tech/meetings` and sign in with
their Calari portal account; Cap has no passwords, sign-up or user admin of its
own. The list shows every meeting for the Calari tenant with search across
titles, clients and transcripts; a meeting page has the player (its 30-second
parts play back to back) and the transcript, where each timestamp jumps the
player to that point.

Access is checked with Calari on every request: before any library page or
audio part is served, Cap asks Calari (signed) whether the person is still
active staff. If Calari says no, the session ends; if Calari cannot be
reached, Cap refuses access. Audio is streamed through Cap after that check;
no storage link that could outlive it is handed out. Sessions also end after
1 hour idle or 8 hours in total. Until Calari defines which meetings staff
accounts may see, only Calari admins can open the library.

Calari user IDs are opaque strings (Calari uses CUIDs), kept exactly as sent;
tenant IDs are Calari workspace UUIDs. A status answer of `active: false`
(Calari sends role `none`) ends the session, and a sign-in without the admin or
staff role is refused.

Contract: `library-signin-contract.md` in the shared Calari handoff folder;
Calari's authorize, exchange and status endpoints are configured per
integration (`login_authorize_url`, `login_exchange_url`, `login_status_url`).
The library is disabled until they exist: `/login` says sign-in is not set up
and deliveries carry no Cap link. It is not part of the phase-1 release.

### Notes, titles and archive

Each meeting row expands in place (keyboard or click) to show the latest note
and the start of the transcript; the meeting page puts notes first, beside the
player and transcript. Times are US Eastern with EST/EDT. Repeated identical
transcript lines (a speech-to-text artefact) are shown once with a count; the
stored transcript is unchanged.

Admins can add, edit and delete notes, rename how a meeting is listed, and
archive or restore a finished meeting. These live only in the `library_*`
tables (migration `20261103200001_library_notes.sql`). The recorded title,
transcript, audio and the frozen Calari delivery are never written, nothing
is re-sent to Calari, and Calari's own summary and tasks are not changed.
Archiving hides a meeting from the main list and makes its notes read-only;
nothing is deleted and the audio stays playable.

Every edit is a same-origin form with the session's token, checked with
Calari like any page, limited to the signed-in tenant, and version-checked: a
stale form gets a 409 page that keeps the user's text. A note form sent twice
creates one note. Limits: titles 200 characters, notes 20,000 characters, 100
notes per meeting. `library_audit` records who changed what, never note text.
Pages send `Referrer-Policy: same-origin`; with `no-referrer` browsers send
`Origin: null` on form posts and the origin check would refuse them.

There is no Calari route for reading its AI notes yet, so the library shows
none and links to the Calari portal (`CALARI_PORTAL_URL`) instead.

## Running the server

```bash
docker build -f crates/cap-server/Dockerfile -t cap-server .
```

| Variable                                                                 | Meaning                                                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                           | Cap's existing PostgreSQL (adds `meeting_*` tables only)                          |
| `AWS_S3_BUCKET_NAME`, `AWS_REGION`, `AWS_S3_ENDPOINT`, `AWS_KMS_KEY_ARN` | Cap's existing private bucket; audio goes under `meetings/`                       |
| `CAP_SERVER_PUBLIC_URL`                                                  | https URL of this server                                                          |
| `CAP_MEETING_INTEGRATIONS`                                               | JSON `[{key_id, tenant_id, secret, delivery_url}]`; secret is base64url, 32 bytes |
| `MEETING_TRANSCRIPTION_PROVIDER`                                         | `local-whisper` (default for production) or `openai-compatible`                   |
| `MEETING_WHISPER_MODEL_PATH`                                             | Path to a whisper.cpp model, mounted into the container                           |
| `MEETING_WHISPER_THREADS`                                                | CPU threads per transcription (1–16; one transcription runs at a time)            |
| `TRUSTED_PROXY_HOP_COUNT`                                                | Proxies in front of the server (Coolify: 1)                                       |

In production the server refuses to start without https URLs, S3, an
integration and a real transcription provider.

The Whisper model is downloaded once from the official whisper.cpp
repository (`ggml-*.bin`) and mounted; it is not in the image. On the current
8-vCPU host without a GPU, `ggml-base.en` or `ggml-small.en` are the realistic
choices; larger models will be slow. The test suite uses `ggml-tiny.en`.

## Tests

```bash
docker compose -f docker-compose.test.yml up -d --wait postgres-test localstack-test
CAP_TEST_DATABASE_URL=postgres://cap:cap@127.0.0.1:5433/cap_test \
CAP_TEST_FFMPEG=$PWD/tests/rust-e2e/ffmpeg-docker.sh cargo test --workspace
python3 tests/rust-e2e/meeting_e2e.py --audio-dir <dir with a.wav/a.ogg, b.wav/b.ogg> --model <ggml model>
```

The end-to-end script runs the server image with real Whisper against
synthetic speech, verifies the signed delivery like Calari will, and checks
the stored audio is KMS-encrypted.
