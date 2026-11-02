# Linux publication: operator steps (for the release owner; Claude performs none of these)

Artifact: dist/desktop/cap-desktop_0.2.0-beta.6_linux-x86_64.deb
sha256 7cbdb79c2b5f06052a4bacbdcfaa70e158d1ecdfd75be9b05caab02a5ea1bdd5, 7919562 bytes.
Built from clean source 5179a45ebd2528f5113b2e21b6202d875e1fd36f (release profile,
CAP_DEFAULT_SERVER_URL=https://meetings.calari.tech, updater artifacts off, no updater endpoint/pubkey,
no CAP_DEV_SERVER_URL or test server in the binary). Supersedes d9da06f8 and 23b7fe4b (do not publish).

1. Copy the .deb and cap-desktop-manifest.json (this folder) to the host.
2. Verify on the host before exposing:
   sha256sum cap-desktop_0.2.0-beta.6_linux-x86_64.deb   # must equal the value above
   stat -c %s cap-desktop_0.2.0-beta.6_linux-x86_64.deb  # 7919562
   dpkg-deb -f cap-desktop_0.2.0-beta.6_linux-x86_64.deb Package Version Architecture Depends
   dpkg-deb --fsys-tarfile cap-desktop_0.2.0-beta.6_linux-x86_64.deb | tar -xO ./usr/bin/cap-desktop | strings | grep -c 'https://meetings.calari.tech'   # >= 1
3. Place as regular, non-symlink, read-only files in CAP_DOWNLOAD_DIR (/srv/downloads):
   cap-desktop_0.2.0-beta.6_linux-x86_64.deb and cap-desktop-manifest.json.
4. Restart or reload the hub per its runbook; confirm /downloads lists Linux as available, Windows
   pending, macOS signing pending, and that the download's size/sha256 match.
5. Do not publish latest.json or any updater file: updates are off for this release.
