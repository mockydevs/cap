"""Print the Tauri config overrides for a release build (JSON on stdout).

    python -I scripts/desktop/release-config.py > tauri.release.json
    pnpm --filter @cap/desktop tauri build --config tauri.release.json

The first releases are direct downloads: no update payload is built. Tauri
CLI 2.11 signs updates without the version, which the app's required
signed-version check rejects, so updates stay off until a version-bound
signer is reviewed. The check itself is never relaxed. If
TAURI_UPDATER_PUBKEY and CAP_UPDATER_ENDPOINT are set they are embedded, so
the app can find a future signed update; until one is published it shows
none. On Windows the FFmpeg fetched by fetch-windows-ffmpeg.py is bundled;
dev builds and `cargo check` never need it.
"""

import json
import os
import re
import sys

pubkey = os.environ.get("TAURI_UPDATER_PUBKEY", "").strip()
endpoint = os.environ.get("CAP_UPDATER_ENDPOINT", "").strip()
if bool(pubkey) != bool(endpoint):
    print("release-config: set both TAURI_UPDATER_PUBKEY and CAP_UPDATER_ENDPOINT, or neither",
          file=sys.stderr)
    sys.exit(1)
if endpoint and not re.match(r"^https://[A-Za-z0-9.-]+/([A-Za-z0-9._-]+/)*latest\.json$", endpoint):
    print("release-config: CAP_UPDATER_ENDPOINT must be https://<host>/<path>/latest.json",
          file=sys.stderr)
    sys.exit(1)

config = {"bundle": {"createUpdaterArtifacts": False}}
if pubkey:
    config["plugins"] = {
        "updater": {"pubkey": pubkey, "endpoints": [endpoint], "requireSignedVersion": True}
    }
if sys.platform == "win32":
    config["bundle"]["externalBin"] = ["binaries/ffmpeg"]
    config["bundle"]["resources"] = {
        "resources/ffmpeg/LICENSE.txt": "ffmpeg/LICENSE.txt",
        "resources/ffmpeg/NOTICE.txt": "ffmpeg/NOTICE.txt",
    }
json.dump(config, sys.stdout)
