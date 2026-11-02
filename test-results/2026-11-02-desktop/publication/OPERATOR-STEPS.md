# Linux publication: operator steps (release owner only; Claude performs none of these)

Follows docs/DOWNLOAD-HUB.md in cap-download-hub. Artifact and manifest values are filled in by the
final package receipt (final-linux-deb.txt) and the generated manifest.json in this folder.

1. Verify the artifact locally against the receipt (sha256sum, stat -c %s, dpkg-deb -f ... Package Version
   Architecture Depends; strings in usr/bin/cap-desktop must contain https://meetings.calari.tech).
2. Build a complete new download set in a fresh staging directory on the host: the new versioned
   installer basename, any installers still being served, and the new manifest.json (this folder's file).
   Do not edit or replace bytes of an installer that is already live; a new build gets a new basename.
3. Regular, non-symlink files only, directly in the directory. Then switch atomically so the host path
   /data/cap/downloads (mounted read-only in the container as /srv/downloads, CAP_DOWNLOAD_DIR) holds the
   complete set; keep the previous set until active downloads finish.
4. Restart the Rust service (the manifest is validated only at startup; it refuses to start if any
   available file is missing or its size/SHA-256 differ). There is no reload endpoint or directory listing.
5. Check GET /api/downloads and the UI #downloads section: Linux available with the receipt's size and
   SHA-256, Windows pending, macOS signing_pending; /downloads/latest.json still 404 (updates off).
