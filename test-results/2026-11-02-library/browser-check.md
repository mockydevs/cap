# Meetings library browser check (Claude, 2026-11-02)
Don's Chrome, local cap-server (dev mode, filesystem storage) at 127.0.0.1:8795 with a stand-in Calari
(auto-approves, verifies the signed exchange/status calls and PKCE) and two synthetic seeded meetings
(espeak speech from the e2e run, real Whisper transcript text). No real people, clients or Calari.
- GET /login -> stand-in authorize -> callback -> signed exchange -> session -> /meetings: works.
- meetings-list.jpg: side panel, list with status badges, transcript preview, staff name/role from Calari.
- meeting-page-seek.jpg: player + transcript; parts play back to back (part 0 rolled into part 1,
  timeline 0:06); clicking 0:01 seeks to 1.7 s and highlights the line.
- Bug found and fixed during the check: local (filesystem) media had no byte-range support, so seeking
  restarted the part; added single-range responses (unit test byte_ranges). S3 serves ranges natively.
