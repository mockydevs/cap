# Controlled live test: real Google Meet, synthetic audio

Purpose: prove on production what the local composite proved with fixtures:
real Google Calendar sync, real Meet guest join and host admission, recording,
Whisper, signed Calari delivery, client-bound notes + task, exactly once.
Root runs it; Don hosts in his own Chrome. Nothing here needs Don's Google
password in any tool, and the notetaker never signs in to Google.

## Preconditions (root checks, in order)

1. Cap deployed at or after the commit that passed the composite (includes
   Calari-400-as-refusal); `GET /healthz` ok.
2. Calari portal deployed with the calendar endpoints and
   `meeting.source = calendar_bot` accepted; a confirmed contact mapping exists
   for the demo client (e.g. demo client `a1f6357c-…`) to a test address Don
   controls or a non-delivering address (e.g. `demo-client@…` that is not a real
   person). No real client is invited.
3. Cap env (Coolify, cap-server only): `CAP_CALENDAR_ENABLED=1`, encryption key,
   key id, bot token, `CAP_CALENDAR_MAX_CONCURRENT=1`,
   `CAP_CALENDAR_ALLOW_STAFF=false`, integration JSON gains
   `calendar_resolve_url` + `calendar_pairing_url`. Boot must succeed (it fails
   loudly if anything is missing).
4. `cap-meeting-bot` service running with `CAP_BOT_ENABLED=1`, the same bot
   token, `CAP_SERVER_URL=https://meetings.calari.tech`, spool volume mounted.
   Logs show `cap-meeting-bot: ready`.

## Steps

1. Don (admin) signs in at `https://meetings.calari.tech/calendar` with
   Calari and clicks **Connect Google Calendar** in his own Chrome; approves
   read-only calendar access for don@calarisolutions.com. Expect "Connected"
   and the account email.
2. Don creates a calendar event 15 minutes ahead, 20 minutes long, with
   Google Meet, title "Cap calendar live test", guests: the demo client's
   confirmed address only. Don accepts it (organiser counts as accepted).
3. Within 5 minutes (sync interval) the event appears on `/calendar` as
   "Notetaker will join" for the demo client. If it says "Choose a client",
   the mapping is wrong: stop and fix the mapping, do not pick "Internal".
4. About 7 minutes before start, Cap requests the pairing from Calari
   (attendance → `ready`). Root checks the attendance row/log
   (`calendar_attendance_log`: scheduled → ready).
5. At start − 2 minutes the bot claims and opens Meet. Don, in his Chrome,
   joins the meeting as host. "Calari Notetaker" appears asking to join;
   Don admits it. Mic and camera of the bot are off.
6. Audio comes from the TEST-ONLY synthetic speaker, not from Don's microphone
   or room. Root runs it by hand, pinned to this one meeting, after the
   notetaker is admitted:

   ```bash
   docker build -f infra/calendar-bot/speaker.Dockerfile -t cap-meet-speaker:test .
   docker run --rm --shm-size 512m --read-only --tmpfs /tmp:rw,nosuid,size=512m \
     --cap-drop ALL --security-opt no-new-privileges:true \
     -e CAP_SPEAKER_ALLOWED_CODE=<meet code> cap-meet-speaker:test \
     --wav /opt/cap-speaker/speech.ogg --minutes 1 --repeat 1
   ```

   It asks to join as "Calari audio test" (camera off, microphone ON: the
   only participant that is), Don admits it, it plays the scripted synthetic
   speech once into its microphone and leaves. It refuses any other meeting
   code, holds no Google credentials, records nothing, and exits at the time
   limit. The notetaker stays muted.

7. Don ends the call for everyone (or leaves; the bot leaves when the meeting
   ends, or after silence).
8. Expect within minutes: attendance `completed`; Cap meeting delivered
   with a Calari receipt; in Calari one CLIENT_MEETING for the demo client
   with a summary and the task, created by Don.

## What root records (evidence)

- Cap: attendance id, states/log, meeting id, `meeting_deliveries` status +
  receipt id, `meeting_transcripts.text` (should contain "staff briefing",
  "Friday", "assigned to").
- Calari: meeting id, client, classification, task(s) with client, one
  CapDelivery row for the Cap meeting.
- Bot logs (no tokens are printed), screenshot of the admitted notetaker.

## Negative checks (same session, cheap)

- Edit the event time by +5 min before preparation → `/calendar` shows the
  new time, one attendance (rescheduled, not duplicated).
- If Meet shows "Continue without microphone and camera" to the notetaker, it
  dismisses it (it has no usable devices on purpose) and asks to join.
- Create a second Meet event with an unmapped guest → "Choose a client",
  no bot.
- After the test: **Disconnect** on `/calendar` → status Disconnected,
  Google access revoked (myaccount.google.com → Security → third-party access
  no longer lists Cap), no future attendance.

## Abort criteria

Stop and set `CAP_CALENDAR_ENABLED=false` (no deploy rollback needed) if:
the bot joins a meeting it should not; anything routes to the wrong client;
Meet shows "You can't join this video call" (Workspace blocks anonymous
guests: change the meeting's host access settings, never sign the bot in);
duplicate Calari meetings or tasks appear.

## Clean-up

Delete the demo Calari meeting and task if they should not stay; the Cap
meeting audio is in the private bucket under the normal retention. Keep
`CAP_CALENDAR_ALLOW_STAFF=false` until per-staff library ownership exists.
