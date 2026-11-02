# Publish the combined CI installers (Linux + Windows)

Root release owner only, after the desktop GUI provider gate passes. Replaces the older
Linux-only OPERATOR-STEPS.md (obsolete; its e959 owner build stays unpublished).

Release: CI run 41379816245, source 49c. Pinned in `publish-combined-ci.py`:

| Platform       | File                                              | Bytes    | SHA-256                                                          |
| -------------- | ------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| linux-x86_64   | cap-desktop_0.2.0-beta.6_linux-x86_64.deb         | 7935324  | d9cd5661f4f6177612508e39a0f406cdf402bf00104edc5cfa8def548bcce909 |
| windows-x86_64 | cap-desktop_0.2.0-beta.6_windows-x86_64-setup.exe | 44995608 | 3b7cf4448c88a125fda1185f4a9f363074a28e2b6d17fa4b58027a5e32e5ff95 |

macOS stays `signing_pending`. The Windows installer is unsigned (SmartScreen may warn). Updates stay
unpublished (`/downloads/latest.json` 404).

1. Staging (already done by root): `/data/cap/downloads/.release-41379816245/` holds `manifest.json`
   and the two files above. It must sit inside `/data/cap/downloads` (same filesystem).
2. Dry run on the host, then read the output:
   `python3 -I publish-combined-ci.py --stage /data/cap/downloads/.release-41379816245 --live /data/cap/downloads`
   It must say "staged release OK" and "will be added" (or "identical bytes, kept") for both files.
   Any "REFUSED" stops here; nothing was changed.
3. Apply: the same command with `--apply`. It backs up the current manifest to
   `manifest.json.bak-<UTC>-<pid>`, adds the installers by temp-copy + fsync + re-hash + 0644 +
   hard link (never overwrites), then swaps in the new manifest atomically (temp, fsync, 0644,
   re-validated against the live directory, rename, directory fsync). Running it again prints
   "already published".
4. Restart ONLY the Cap Rust service (Coolify "Restart" on the Cap application, or
   `docker restart <cap-server container>`). The manifest is validated only at startup; if it is
   wrong the service refuses to start (then do step 6).
5. Verify: `GET https://cap.calari.tech/healthz` 200; `GET /api/downloads` shows Linux and Windows
   `available` with the sizes/hashes above, macOS signing_pending, updates not_published; HEAD each
   `/downloads/<file>` returns 200 with `X-Artifact-Sha256` equal to the table; `/downloads/latest.json`
   404; the hub page shows both cards and the "Windows installer is currently unsigned" note; admin
   login (CORS) still works.
6. Roll back (manual, only if step 4/5 fails): atomically restore the backup
   (`cp manifest.json.bak-<...> .manifest.json.rollback && mv .manifest.json.rollback manifest.json`),
   restart the Cap service again, re-check `/healthz`. Leave the added installer files in place
   (the hub only serves files listed in the manifest). Do not delete or edit live installers.

Tested against copies of the real CI files in a scratch directory
(`publish-combined-ci-test.txt`): dry run, apply (0644, backup kept, manifest equals the CI
manifest), re-apply (no-op), live file with different bytes (refused), tampered staged file (refused).
Not tested on the production host. Claude performed no production action.
