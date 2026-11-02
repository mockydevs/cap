# Cap calendar attendance: implementation result

## Test-only synthetic speaker (root request 21:42Z)

- `cap-meet-speaker` (feature `test-speaker`, own image
  `infra/calendar-bot/speaker.Dockerfile`, never in the notetaker image):
  joins one pinned Meet code (argument must equal CAP_SPEAKER_ALLOWED_CODE)
  as "Calari audio test", camera off, microphone ON, plays the baked-in
  synthetic speech into a PulseAudio null sink remapped as its microphone,
  leaves; hard time limit (1-30 min); env allowlist; no Google credentials.
- Notetaker now also dismisses Meet's "Continue without microphone and
  camera" prompt (muted participants only).
- Tests: `test_speaker_joins_unmuted_and_plays_only_the_script` (refuses a
  mismatched code before opening anything; joined trusted, never muted, cam
  off, page heard its microphone at peak 1.0, left); notetaker fixture now
  shows the no-device prompt first. 7/7 container tests, composite vs real
  local Calari, workspace 144/0, clippy 0, fmt, prettier; speaker image
  uid 10003, no localhost policy; notetaker image has no speaker binary.
- Live plan updated: docs/integrations/calari/CALENDAR-LIVE-TEST.md step 6.

## Runner environment hardening (root request 21:32Z)

- Entrypoint keeps only an explicit allowlist of variables before starting
  Xvfb/PulseAudio/the runner (no values in arguments); Xvfb and PulseAudio
  start without the runner token; the runner drops it from its environment
  after reading; Chrome keeps its cleared environment; runner non-dumpable.
- Test `injected_platform_secrets_never_reach_runner_processes`: fake
  DATABASE_URL, AWS_SECRET_ACCESS_KEY, CAP_MEETING_INTEGRATIONS,
  GOOGLE_OAUTH_CLIENT_SECRET, CAP_CALENDAR_ENCRYPTION_KEY and
  CAP_CALENDAR_BOT_TOKEN injected; during recording every process's real
  /proc/<pid>/environ (runner, Xvfb, pulseaudio, ffmpeg, all chromium) has
  none of them, and only PID 1 (runner) has the runner token. Fails on the
  previous image (`counter-evidence-env-allowlist.log`: PID 1 carried
  FAKE-DB-SECRET-1); passes now. All 6 container tests exit 0 with real
  Whisper; workspace 142/0; clippy 0; fmt; prettier; prod image rebuilt.

## Composite gate (root addendum 2026-11-02 20:49Z)

Real local Cap + real local Calari (portal head 2108496 on main 6330c28,
calendar adapter + receiver + worker, kit by claude:cbd574a6) + real runner
container + real Whisper (ggml-tiny.en). FIXTURES: Google Calendar/OAuth,
Google Meet page, Calari's AI step (portal kit's local AI fixture). Test:
`crates/meeting-bot/tests/composite.rs`, log `composite-real-calari.log`
(exit 0).

- Staff session verified live by Calari's signed status; exact mapping
  pat.lee@acme-dental.example → Demo Acme Dental scheduled; the same meeting
  twice in the calendar → one attendance; ambiguous (Acme + Beta) → both
  offered, nothing scheduled until the staff member chose Beta; unmapped and
  archived-client attendees → no client, never internal.
- One real Calari calendar pairing (staff_client, Acme). Calari refused (no
  pairing created): unknown client, internal kind with a client, client kind
  without one, reused request id with a different body, unknown staff.
- Runner joined the fixture meeting, recorded, uploaded; Cap delivered; the
  proxy hid Calari's first 200 behind a 503, Cap retried, Calari answered 200
  again and kept ONE delivery row; Cap stored the Calari receipt; no further
  sends.
- Calari verify: one CLIENT_MEETING for Demo Acme Dental, status READY,
  notes (AI fixture quoting the real transcript), one task bound to Acme.
- Disconnect: Google fixture revoke, nothing left scheduled, no new pairing.
- Fixes found by this gate: Cap now treats Calari 400 as a refusal (needs
  review, no retries); Cap sends no `cap_url` unless its public URL is https
  (Calari requires https; local http otherwise caused a 400).
- Shared local Calari DB keeps one meeting per run (two runs → two rows, each
  with one delivery).
- Workspace 141 passed / 0 failed; clippy 0; fmt; pnpm format:check ok.

## Review round 3 (fix for review-round-2.md)

- P1 lease control-thread gap: the join/record thread no longer makes any
  network call while a browser or capture is live; "waiting" and the first
  "recording" report only update state and wake the heartbeat thread. An
  independent watchdog kills Chrome the instant the local deadline passes.
- New container tests `hung_waiting_report_leaves_before_server_lease` and
  `hung_first_recording_report_stops_capture_before_server_lease` (page pings
  `/alive` every 500 ms; only in-meeting reports count as lease renewals).
  Fixed runner: browser gone 14.9 s / 15.1 s after the last confirmed report,
  before the 20 s server lease; recording meeting ends before lease, one
  meeting, delivered once. Counter-evidence `counter-evidence-ca07c50.log`
  (exit 101): ca07c50 runner alive 24.2 s / 21.7 s, past the lease.
- All 5 container tests exit 0 with real Whisper (`bot-e2e-real-whisper.log`);
  workspace 140 passed / 0 failed; clippy 0; fmt clean; prod image rebuilt.

## Review round 2 (fixes for review-round-1.md)

- P1 #1 lease: runner keeps a local fail-closed deadline (send time of last
  confirmed report + granted lease − min(10 s, lease/4)); failed/hung reports
  never extend it; it stops capture and leaves by then; heartbeat thread is
  never waited on. Server returns `lease_seconds` on every report
  (`CAP_CALENDAR_BOT_LEASE_SECONDS`, 20–600, default 90), re-queues a lapsed
  lease only when no meeting exists for the device, keeps the meeting open for
  recovery (finalized after 30 min without chunks), revokes the device only
  once the meeting is finalized.
- P1 #2 spool: durable private spool volume (`/var/lib/cap-bot`, named volume
  `calendar-bot-spool`), per-meeting token file (0600), deleted only after the
  server confirms finalize (quarantined audio kept), startup/idle recovery via
  the recorder's `recover_all` with that meeting's own token only, never
  rejoins; spool cap (`CAP_BOT_SPOOL_MAX_MB`, 2048) refuses new meetings
  instead of deleting; unfinished upload reported as failed.
- Evidence: `bot-e2e-real-whisper.log` exit 0, 3 container tests:
  `unconfirmed_lease_stops_capture_before_server_expiry` (reports hung; runner
  left 15.2 s after the last confirmed report, before the 20 s server lease;
  meeting ended before lease; one meeting, one join, delivered once) and
  `upload_outage_and_restart_deliver_once_without_rejoining` (uploads 503 for
  the whole meeting → failed "kept on the runner", 0 chunks on server, tick
  did not revoke, container removed and replaced on same volume, uploads
  restored → same audio finalized + delivered once with real Whisper, one
  meeting, one join, spool empty).
- Counter-evidence: `counter-evidence-48348fd.log` (exit 101): the same two
  tests against a runner image built from 48348fd both fail (never left the
  meeting; audio deleted, "upload failed").
- Workspace 138 passed / 0 failed; clippy 0 warnings; fmt clean; prod image
  rebuilt (`bot-image-prod-*.log`).

Owner: claude:9bd968c2-5830-42fd-a3fc-673ac2d8d96e (Claude Desktop)
Worktree: /home/don/code/cap-calendar, branch codex/cap-calendar, base 4350356.
Commits: 1d81430 (implementation), merge of origin/main 4c722b4 (root privacy
route, clean), then the final commit named in the handoff event (Eastern time
display + receipts). `git log codex/cap-calendar`.
Not pushed, not deployed, nothing enabled. No live Google, Calari, meeting or
client data was touched. Root's dirty calendar.rs/google_calendar.rs/lib.rs/docs
were kept and extended.

## What was built

- cap-server `attendance/` module: per-staff Google OAuth (state + PKCE bound
  to Cap session, Calari user id, HttpOnly browser cookie; single use),
  ChaCha20-Poly1305 encryption at rest (row/purpose/key-id AAD), bounded
  rolling-window sync (now-1h..now+14d, singleEvents, durable page cursor,
  window-complete deletion detection), scheduler (per-meeting advisory lock,
  dedupe, reschedule, cancel/decline/pause, ownership transfer, lease fencing,
  crash re-queue, interrupted finalize), signed Calari resolve/pairing client
  (purpose `calendar`, pairing_kind), internal calendar_bot device issuance,
  runner API (`/v1/calendar-bot/claim`, `/attendances/{id}/report`), staff UI
  `/calendar` (admin-only by default).
- Only meetings the staff member organised or accepted are attended.
- crates/meeting-bot + infra/calendar-bot image: Chromium over CDP (trusted
  input, no stealth), Meet guest join with waiting room, PulseAudio capture via
  cap-meeting-recorder, heartbeat/lease, non-dumpable runner, cleared Chrome
  env, Chrome URL policy. Compose service `cap-meeting-bot` on its own
  network; cap-server gets calendar env (off by default).
- Times on /calendar shown in CAP_DISPLAY_TIMEZONE (default America/New_York,
  EST/EDT label); instants stored UTC with Google offsets.
- Routes: Google callback `{CAP_SERVER_PUBLIC_URL}/calendar/google/callback`.
- Docs: docs/integrations/calari/CALENDAR.md, CALENDAR-PORTAL-CONTRACT.md.

## Evidence (test-results/calendar/)

| Command                                                                                                                                                                            | Exit | Result                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CAP_TEST_DATABASE_URL=… cargo test --workspace --features cap-meeting-bot/fake-meet`                                                                                              | 0    | 140 passed, 0 failed (`cargo-test-workspace.log`; attend test self-skips here, run separately below)                                                                                                                                                                                                   |
| `… CAP_TEST_BOT_IMAGE=cap-meeting-bot:calendar-test CAP_TEST_WHISPER_MODEL=ggml-tiny.en cargo test -p cap-meeting-bot --features fake-meet,cap-server/local-whisper --test attend` | 0    | real runner container joined local Meet stand-in, trusted clicks, name "Calari Notetaker", mic/cam off, waited, admitted, recorded synthetic speech, left on end (31 s); real Whisper transcript; signed delivery verified; client routed; receipt rcpt-1; device revoked (`bot-e2e-real-whisper.log`) |
| `cargo clippy --workspace --all-targets --features cap-meeting-bot/fake-meet`                                                                                                      | 0    | 0 warnings (`clippy.log`)                                                                                                                                                                                                                                                                              |
| `cargo fmt --all -- --check`                                                                                                                                                       | 0    | (`fmt.log`)                                                                                                                                                                                                                                                                                            |
| `docker build -f infra/calendar-bot/Dockerfile` (prod, no test features)                                                                                                           | 0    | runs as uid 10002, policy has no localhost, refuses http server (`bot-image-prod-build.log`, `bot-image-prod-check.log`)                                                                                                                                                                               |
| `docker compose -f docker-compose.coolify.yml config --quiet` (placeholder values)                                                                                                 | 0    | (`compose-config.log`)                                                                                                                                                                                                                                                                                 |

Calendar integration tests (crates/cap-server/tests/calendar.rs, 8): OAuth
binding/CSRF/cross-user/replay/wrong account/missing scope; page-cursor
resume after a 500; dedupe across calendars; timezone; reschedule in place
and moved copy; stale update ignored; delete/decline/vanished cancel; pause;
prepare → Calari pairing → claim → cap of 1 → fenced reports → upload →
signed delivery (source calendar_bot) → device revoked; crash re-queue and
dead lease fenced; skip-while-waiting stops bot; Calari refusal → needs
review; Google revoke → needs reconnect; staff deactivated → revoked;
disconnect → Google revoke + delete events; concurrent reconcile → one
attendance; endless recurring series finite and rolls in; unanswered/tentative
invites ignored; non-Meet events not stored; admin-only gate.

Security review (independent agent, static): 0 high; 2 medium + 4 low, all
fixed in 1d81430 (accepted-only, non-dumpable runner + cleared Chrome env +
narrower allowlist, attendance-true routing label, event deletion/pruning,
token length, bounded Calari read). Root early-review items fixed: bounded
window sync; Claim/Report/pairing-response Debug redacted.

## Limits / remaining (root)

1. Portal endpoints (worker cbd574a6) must ship first; until then pairing
   fails closed. Calari must also accept `meeting.source = "calendar_bot"`.
2. Google OAuth app is Testing: refresh tokens expire in 7 days until
   branding + publishing. Register redirect URI above; scopes `openid email
calendar.events.readonly`.
3. Chrome sandbox off in Docker (default seccomp); container isolation +
   non-dumpable runner instead. Follow-up: ship Chrome seccomp profile.
4. Real Google Meet DOM not tested (stand-in only); needs root's controlled
   live meeting. Google may refuse anonymous guests in some Workspace orgs.
5. /calendar admin-only (CAP_CALENDAR_ALLOW_STAFF) until per-staff library
   ownership exists.
6. The bot e2e and Calari receiver are local stand-ins (fake Meet page, fake
   Calari); real Google Meet + real portal + Don's calendar remain root's gate.
7. Local test tooling: user-level `pipx install cmake` used to build
   local-whisper; test Postgres container `cap-calendar-pg-test` on 5447.
