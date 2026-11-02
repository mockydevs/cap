# Calendar attendance

Status: implemented on `codex/cap-calendar`, tested locally against stand-ins.
NOT enabled in production. Release needs the portal contract
(`CALENDAR-PORTAL-CONTRACT.md`), Google OAuth setup, a controlled live meeting
and an approved deployment.

## What it does

A Calari staff member signs in to Cap (existing "Sign in with Calari"), opens
`/calendar`, connects Google Calendar once, and from then on a notetaker named
`CAP_CALENDAR_BOT_NAME` (default "Calari Notetaker") asks to join their Google
Meet meetings. The host admits it, it records the meeting audio, and the
transcript reaches Calari through the existing pipeline (Whisper → signed
delivery) as a meeting created by that staff member, for the right client.
No paid bot service; everything runs on the existing server.

## Decisions (unchanged from the audit)

- Self-hosted, Google Calendar + Google Meet first. Don is the first user.
- Ownership/access stay in Calari. A grant belongs to one active staff member.
  Revoked staff never schedule; Calari re-checks at pairing and delivery.
- Client routing: the staff member's explicit choice, else exact verified
  attendee emails that Calari maps to exactly one client the staff member may
  access. Anything else asks the staff member ("Choose a client"). Titles,
  descriptions and domains never route.
- Calendar OAuth is separate from Drive: read-only events scope
  (`calendar.events.readonly`), `include_granted_scopes=false`, offline
  refresh token encrypted at rest, one-time state + PKCE.
- Meet admission and recording rules apply. The bot never bypasses a waiting
  room, sign-in requirement or challenge, and hides nothing about automation.

## Components

| Piece | Where |
| --- | --- |
| Policy (routing, Meet code, decide) | `crates/cap-server/src/calendar.rs` |
| Google transport (OAuth, events, revoke, userinfo) | `crates/cap-server/src/google_calendar.rs` |
| Encryption at rest (ChaCha20-Poly1305, row-bound AAD) | `attendance/crypto.rs` |
| Signed Calari calls (resolve, pairing) | `attendance/calari.rs` |
| Sync with durable page cursor | `attendance/sync.rs` |
| Reconcile/schedule/prepare/expire | `attendance/schedule.rs` |
| Runner API (claim, fenced reports) | `attendance/bot_api.rs` |
| Staff settings UI + OAuth | `attendance/web.rs` (`/calendar`) |
| Schema | `migrations/20261103000001_calendar.sql` |
| Runner (Chrome over CDP, recorder reuse) | `crates/meeting-bot` |
| Runner image | `infra/calendar-bot/` |

### Flow

1. **Connect** (`POST /calendar/connect`, CSRF + same origin): one-time state
   (hash stored), PKCE verifier, bound to the Cap session, the Calari staff id
   and an HttpOnly browser cookie. Callback requires all of them, single use.
   Cap requires a refresh token, the calendar scope and a verified email equal
   to the staff member's Calari email (`CAP_CALENDAR_REQUIRE_SAME_EMAIL`,
   default on); otherwise it revokes what Google gave and stores nothing.
2. **Sync** (every `CAP_CALENDAR_SYNC_SECONDS`, leased per connection):
   each run lists one bounded rolling window, `now − 1 h` to `now + horizon`
   (`CAP_CALENDAR_HORIZON_DAYS`, 14), with `singleEvents=true` and
   `showDeleted=true`. Recurring series (including ones with no end) are
   expanded by Google only inside the window, so every run is finite, and new
   instances enter as the window moves without anyone editing the event.
   Each page's events and the next page token commit in one transaction (a
   crash resumes at the next page of the same window). After a complete run,
   events inside the window that were not listed are cancelled (deleted or
   moved out). Google sync tokens are deliberately not used: with expanded
   instances they are unbounded. Stale updates (older `updated`) are ignored.
   Only Google Meet events are stored; all-day events never schedule. Times
   are stored as UTC instants; DST is Google's (instances carry their own
   offsets).
3. **Resolve**: Calari returns staff status and verified attendee→client
   mappings (only clients that staff member may access). Inactive staff →
   connection revoked (Google revoke, credential deleted, attendance cancelled).
4. **Reconcile** (per meeting advisory lock): one attendance per tenant + Meet
   code + start time, shared by every connected calendar with that meeting.
   Only meetings the staff member organises or has **accepted** schedule;
   unanswered ("needsAction"), tentative and declined invites never bring
   the bot (Google adds outsiders' invites automatically).
   Edits reschedule (new version → new pairing); a moved copy in one calendar
   gets its own attendance; delete/decline/skip/pause cancels; a meeting that
   has started is never cancelled merely because time passed.
5. **Prepare** (`start − join lead − 5 min`): Cap asks Calari for a pairing as
   the owning staff member (idempotent request id per version). Cap accepts it
   only if it is unredeemed and its kind/client match the routing, redeems it
   internally into a `calendar_bot` device (never possible via public redeem)
   and stores the device token encrypted. Refusal → `needs_review`.
6. **Claim** (runner, `start − join lead`): concurrency cap
   `CAP_CALENDAR_MAX_CONCURRENT` (default 1) under an advisory lock. The runner
   receives a Meet code (not a URL), title, display name, `leave_by` and the
   one-meeting device token.
7. **Attend**: joining → waiting → recording → completed/failed, each report
   fenced by the lease token (`CAP_CALENDAR_BOT_LEASE_SECONDS`, 90 s; 20 s
   heartbeat). Cancellation reaches the bot as `continue: false`.
   **Fail-closed lease:** the runner keeps a local deadline = send time of the
   last report the server confirmed + the granted lease − a margin
   (min(10 s, lease/4)). Failed, refused or hung reports never extend it; past
   it the runner stops capturing and leaves, so it is gone before the server
   could hand the meeting to another runner. Server side, a lapsed lease is
   re-queued only if no meeting exists for the attendance's device (so a
   meeting is never recorded twice); otherwise the attendance is failed and
   its meeting stays open for the runner's recovery upload. A lost runner's
   open meeting that receives nothing for 30 minutes is finalized with the
   audio that arrived; its device is revoked only after the meeting is
   finalized.
8. **Deliver**: the existing worker transcribes and sends the signed delivery
   (`meeting.source = calendar_bot`, `provider_hint = google_meet`,
   `meeting_url = https://meet.google.com/<code>`). Finished attendances
   revoke their device and drop the stored token.

### Runner behaviour

Headed Chromium on a private Xvfb display; meeting audio to a private
PulseAudio null sink (`cap_bot`), microphone is a silent null source;
mic and camera switched off before asking to join. Trusted CDP mouse/keyboard
input; no stealth plugins, user-agent or WebGL spoofing. Waiting room limit
`CAP_BOT_WAITING_SECONDS` (600). Leaves when the meeting ends, the server says
stop, `leave_by` (end + 30 min) passes, or 6 + 3 minutes of silence (everyone
left). Audio goes through `cap-meeting-recorder` (30 s segments, resumable
uploads). Browser profiles live on tmpfs and are deleted after each meeting.

**Durable spool** (`CAP_BOT_SPOOL_DIR`, `/var/lib/cap-bot`, a private named
volume `calendar-bot-spool`, 0700): `<attendance>/` holds segments + journal,
`<attendance>.token` (0600) that meeting's own device token. Nothing is
deleted until the server confirms the meeting finalized; segments the server
refused for good are kept for an operator. On start and between meetings the
runner uploads and finalizes leftovers with each meeting's own token (the
recorder's recovery); it never rejoins or records again. An unfinished upload
is reported as `failed` ("audio is kept on the runner…"), never as success.
Cap: `CAP_BOT_SPOOL_MAX_MB` (2048); above it the runner refuses new meetings
until uploads drain (fails closed, deletes nothing). Recovery window: until the
server finalizes the meeting (30 min after the last chunk it received) and the
device expires (meeting end + 48 h); later, the audio stays in the spool for
an operator.

## Configuration

Cap server (all required when `CAP_CALENDAR_ENABLED=1`; boot fails otherwise):

| Variable | Meaning |
| --- | --- |
| `CAP_CALENDAR_ENABLED` | `1` to enable; unset = feature fully off |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | existing Google OAuth client |
| `CAP_CALENDAR_ENCRYPTION_KEY` | base64url (no padding), 32 random bytes |
| `CAP_CALENDAR_ENCRYPTION_KEY_ID` | label stored with ciphertexts (default `v1`); changing it forces reconnects |
| `CAP_CALENDAR_BOT_TOKEN` | runner bearer token (≥ 32 random chars; only its hash is kept) |
| `CAP_CALENDAR_MAX_CONCURRENT` | 1–4 (default 1) |
| `CAP_CALENDAR_JOIN_LEAD_SECONDS` | default 120 |
| `CAP_CALENDAR_SYNC_SECONDS` | default 300 |
| `CAP_CALENDAR_HORIZON_DAYS` | default 14 |
| `CAP_CALENDAR_BOT_NAME` | name shown in the meeting (default "Calari Notetaker") |
| `CAP_CALENDAR_REQUIRE_SAME_EMAIL` | default on; `0` allows a different Google account |
| `CAP_DISPLAY_TIMEZONE` | zone for times on `/calendar` (default `America/New_York`, shown with EST/EDT); storage stays UTC |
| `CAP_CALENDAR_ALLOW_STAFF` | default off: only Calari admins may use `/calendar` until the meetings library enforces per-staff ownership (separate phase) |
| `CAP_MEETING_INTEGRATIONS[].calendar_resolve_url`, `.calendar_pairing_url` | Calari endpoints (both, https) |

Google endpoint overrides (`CAP_CALENDAR_GOOGLE_*`) are refused in production.

Google Cloud OAuth client: add redirect URI
`https://<cap-server public host>/calendar/google/callback`, enable the
Google Calendar API, add scope `calendar.events.readonly` to the consent screen.

Runner container (`infra/calendar-bot/Dockerfile`, service `cap-meeting-bot`
in `docker-compose.coolify.yml`): `CAP_BOT_ENABLED` (idles without
credentials when off), `CAP_SERVER_URL` (https; the public Cap URL),
`CAP_BOT_RUNNER_TOKEN` or `CAP_BOT_RUNNER_TOKEN_FILE`. The runner makes itself
non-dumpable (`PR_SET_DUMPABLE=0`) and starts Chrome with a cleared
environment, so a compromised renderer running as the same user cannot read
the token from its environment or memory. The compose service is on its own
`calendar-bot` network (no access to `cap-internal`).
Suggested limits: `--memory 2g --cpus 2 --shm-size 512m --read-only
--tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`, its own network
with egress to the internet only (no access to the database or other internal
services), and no Docker socket. Chromium's sandbox needs user namespaces,
which Docker's default seccomp profile blocks, so the image sets
`CAP_BOT_CHROME_NO_SANDBOX=1`. Container isolation is the boundary; supplying
Chrome's seccomp profile and unsetting the variable re-enables the sandbox.
A Chrome policy blocks navigation outside google.com/gstatic.com/googleapis.com, downloads,
extensions, sign-in and sync (defence in depth; WebRTC media is not limited
by it).

## Security properties (tested)

See `crates/cap-server/tests/calendar.rs` and `crates/meeting-bot/tests/attend.rs`.
OAuth state/PKCE/session/browser binding and single use; CSRF and origin
checks; another staff member cannot consume an attempt or change events; no
plaintext refresh token anywhere in the row; mismatched Google account or
missing scope is revoked and not stored; refresh revoked at Google →
needs reconnect + cancel; staff deactivated → revoke + cancel; disconnect →
Google revoke + delete + cancel; runner token required; lease fencing (wrong
or expired lease refused, crash re-queue); meeting/device ownership on
reports; public redeem cannot mint a bot device; one attendance under
concurrent reconciliation; signed delivery verified by the receiver.

## Known limits

- Google OAuth app is in External/Testing: Google expires refresh tokens after
  7 days until the app is published (root: branding + publishing). Until then
  staff must reconnect weekly; "connect once" holds only after publishing.
- The Chrome sandbox is off inside Docker (user namespaces blocked by the
  default seccomp profile); isolation relies on the container, non-root,
  non-dumpable runner and the policy allowlist. Shipping Chrome's seccomp
  profile to re-enable the sandbox is a recommended follow-up.

- Requires the Calari portal contract; until Calari implements it, preparing a
  pairing fails closed (no recording).
- A staff member deactivated while the bot is already recording is stopped by
  Calari at delivery (pairing creator must be active), not by Cap mid-meeting.
- If two calendars disagree on the client for the same meeting, the owning
  (first) calendar's routing is used; the other staff member's choice does
  not override it.
- Choosing "Don't join" while recording stops the bot; what was recorded is
  still delivered, like stopping a desktop recording.
- Google may refuse anonymous guests for some Workspace meetings ("You can't
  join this video call"); the attendance then fails with that reason.
- The Meet page text/labels the runner reads are English (`hl=en`); Meet UI
  changes can break joining. The stand-in test proves the mechanism; the
  controlled live meeting proves today's Meet.
- Recurring events are expanded instances; editing "all events" re-syncs each
  instance.
