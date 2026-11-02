# Installed desktop app -> current Cap -> real Whisper -> local Calari AI notes/tasks -> library (PASS)

Fixed runtime 553db6b. DEBUG TEST package (never publish) built from clean 3179b12, sha256
5ea8c104762e5ebd80c2213eaf55cf675aff4b1c977c2ad412e48cc7a4722a3f; the installed
/usr/bin/cap-desktop hash equals the package's (b8e0e9d1...). Fixture: root's v4 run (frozen
helper 49d691e5, cap-server:claude-rc-b3314d2, local Calari 0aa8252 rebuilt + migrated).

1. Fresh pairing: local Calari sign-in with the protected fixture login, POST client pairing 201.
2. `cap://pair` link opened -> "Add note taker?" (02) -> Start -> "Recording for Example Studio
   (synthetic)" (03), Pulse: silent mic + synthetic speech on the speakers.
3. ~45 s -> "Stop and upload" -> window says "Uploaded to Cap. The transcript is being made and then
   sent to Calari." (05).
4. Cap meeting 8cd7bf13: transcribed (cap-whisper ggml-base.en, 7 segments), "delivered to Calari",
   delivery status delivered / HTTP 200 / ack accepted. Calari's built contract accepts the stored
   body: duration 45389 ms, last segment ends 45081 ms (`delivery-contract-check.json`).
5. Calari meeting 637922ff: READY, classification CLIENT_MEETING, client-bound, summary present,
   sourceUrl = https://localhost:8790/meetings/8cd7bf13-... (canonical https cap_url), 1 action
   proposal, APPROVED by the harness's explicit staff review step (not auto-created) -> task.
   Harness phase "Chrome recording -> real notes and tasks: PASS" (the desktop delivery).
6. Library (`library-check.json`), all through the https front with only the running proxy's
   certificate trusted: signed-out page/audio 303; Cap /login -> Calari authorize (callback
   https://localhost:8790/auth/calari/callback); admin approve 201; callback 303; list 200 with the
   title; meeting page 200 with transcript (7 segments) and player playlist; audio Range 206
   audio/ogg 1024 bytes.

Before the fix (same fixture, package 084d808): Calari rejected the delivery (400) because 62.5 s
of audio ran past a 60.1 s meeting; kept in ../ (delivery-contract-check.json, segment-times.json).
Not covered: real microphones/speakers, Wayland, Windows/macOS GUI, production recording,
production-only Secure/__Host- cookies (root verified live login cookie metadata).
