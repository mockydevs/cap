# Cap calendar attendance: implementation result

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
| Command | Exit | Result |
| --- | --- | --- |
| `CAP_TEST_DATABASE_URL=… cargo test --workspace --features cap-meeting-bot/fake-meet` | 0 | 138 passed, 0 failed (`cargo-test-workspace.log`; attend test self-skips here, run separately below) |
| `… CAP_TEST_BOT_IMAGE=cap-meeting-bot:calendar-test CAP_TEST_WHISPER_MODEL=ggml-tiny.en cargo test -p cap-meeting-bot --features fake-meet,cap-server/local-whisper --test attend` | 0 | real runner container joined local Meet stand-in, trusted clicks, name "Calari Notetaker", mic/cam off, waited, admitted, recorded synthetic speech, left on end (31 s); real Whisper transcript; signed delivery verified; client routed; receipt rcpt-1; device revoked (`bot-e2e-real-whisper.log`) |
| `cargo clippy --workspace --all-targets --features cap-meeting-bot/fake-meet` | 0 | 0 warnings (`clippy.log`) |
| `cargo fmt --all -- --check` | 0 | (`fmt.log`) |
| `docker build -f infra/calendar-bot/Dockerfile` (prod, no test features) | 0 | runs as uid 10002, policy has no localhost, refuses http server (`bot-image-prod-build.log`, `bot-image-prod-check.log`) |
| `docker compose -f docker-compose.coolify.yml config --quiet` (placeholder values) | 0 | (`compose-config.log`) |

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
