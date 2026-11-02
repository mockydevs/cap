# Publish the combined CI installers (Linux + Windows)

**PINNED to CI run 41383982100 (receipt commit 0caf02057c2a58346abe74a35da221fd15784b6d = runtime
553db6b + production CSS). The earlier 49c installers (d9cd5661 / 3b7cf444) contain the started_at
bug and must never be published.**

Root release owner only, after the desktop GUI provider gate (passed on 553db6b). Replaces the
older Linux-only OPERATOR-STEPS.md.

| Platform       | File                                              | Bytes    | SHA-256                                                          |
| -------------- | ------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| linux-x86_64   | cap-desktop_0.2.0-beta.6_linux-x86_64.deb         | 7935440  | e39cd10aa8dccb8d9325a56ee570425b3b8ff98c98dbb21ee744c53dd80e6fa6 |
| windows-x86_64 | cap-desktop_0.2.0-beta.6_windows-x86_64-setup.exe | 44976241 | f76fba04b4cb93e407a69523d580b2cc1f8a42a73e2fbba2cc71ab522f684906 |

macOS stays `signing_pending`. The Windows installer is unsigned (SmartScreen may warn). Updates stay
unpublished (`/downloads/latest.json` 404).

1. Staging (root, only after the final audited CI 41383982100 receipt; not done yet): create
   `/data/cap/downloads/.release-41383982100/` with that run's `manifest.json` and the two files
   above, inside `/data/cap/downloads` (same filesystem). The live catalog must exist and still be
   the pending-only one (or this exact release); the script refuses a missing or any other catalog.
2. Record the live manifest state: `sha256sum /data/cap/downloads/manifest.json` (it must exist and
   be the pending-only catalog; a missing manifest is refused). Dry run on the host, then read the output:
   `python3 -I publish-combined-ci.py --stage /data/cap/downloads/.release-41383982100 --live /data/cap/downloads --expect-current-sha <that sha256>`
   It must say the live manifest matches, "staged release OK" and "will be added" (or "identical
   bytes, kept") for both files. Any "REFUSED" stops here; nothing was changed.
3. Apply: the same command with `--apply`. It holds an exclusive lock (`.publish.lock`), re-checks
   the live manifest against `--expect-current-sha`, backs that exact snapshot up to
   `manifest.json.bak-<UTC>-<pid>`, adds the installers by temp-copy + fsync + re-hash + 0644 + hard
   link (never overwrites), then swaps in the new manifest atomically (temp, fsync, 0644, re-validated
   against the live directory, live manifest re-checked unchanged, rename, directory fsync). Running
   it again prints "already published".
4. Restart ONLY the cap-server container (the Rust service that mounts `/srv/downloads`), not the
   whole Coolify application: root first verifies the exact container name for the Cap server service
   (e.g. `docker ps --filter "label=coolify.serviceName=cap-server"` or the Coolify service view), then
   `docker restart <that exact container>` or Coolify's per-service restart for that one service. The
   manifest is validated only at startup; if it is wrong the service refuses to start (then do step 6).
5. Verify: `GET https://cap.calari.tech/healthz` 200; `GET /api/downloads` shows Linux and Windows
   `available` with the sizes/hashes above, macOS signing_pending, updates not_published; HEAD each
   `/downloads/<file>` returns 200 with `X-Artifact-Sha256` equal to the table; `/downloads/latest.json`
   404; the hub page shows both cards and the "Windows installer is currently unsigned" note; admin
   login (CORS) still works.
6. Roll back (manual, only if step 4/5 fails): atomically restore the backup
   (`cp manifest.json.bak-<...> .manifest.json.rollback && mv .manifest.json.rollback manifest.json`),
   restart that same cap-server container again, re-check `/healthz`. Leave the added installer files in place
   (the hub only serves files listed in the manifest). Do not delete or edit live installers.

Tested against copies of the real CI files in a scratch directory
(`publish-combined-ci-test.txt`): dry run, apply (0644, backup kept, manifest equals the CI
manifest), re-apply (no-op), live file with different bytes (refused), tampered staged file (refused).
Not tested on the production host. Claude performed no production action.
