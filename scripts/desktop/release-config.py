"""Print the Tauri config overrides for a release build (JSON on stdout).

    python -I scripts/desktop/release-config.py > tauri.release.json
    pnpm --filter @cap/desktop tauri build --config tauri.release.json

Reads TAURI_UPDATER_PUBKEY and CAP_UPDATER_ENDPOINT (repository variables)
and fails if either is missing, so no release ships without signed updates.
On Windows it also bundles the FFmpeg fetched by fetch-windows-ffmpeg.py;
dev builds and `cargo check` never need it.
"""

import json
import os
import re
import sys


def need(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        print(f"release-config: {name} is required for a release build", file=sys.stderr)
        sys.exit(1)
    return value


pubkey = need("TAURI_UPDATER_PUBKEY")
endpoint = need("CAP_UPDATER_ENDPOINT")
if not re.match(r"^https://[A-Za-z0-9.-]+/([A-Za-z0-9._-]+/)*latest\.json$", endpoint):
    print("release-config: CAP_UPDATER_ENDPOINT must be https://<host>/<path>/latest.json",
          file=sys.stderr)
    sys.exit(1)

config = {
    "bundle": {"createUpdaterArtifacts": True},
    "plugins": {
        "updater": {
            "pubkey": pubkey,
            "endpoints": [endpoint],
            "requireSignedVersion": True,
        }
    },
}
if sys.platform == "win32":
    config["bundle"]["externalBin"] = ["binaries/ffmpeg"]
    config["bundle"]["resources"] = {
        "resources/ffmpeg/LICENSE.txt": "ffmpeg/LICENSE.txt",
        "resources/ffmpeg/NOTICE.txt": "ffmpeg/NOTICE.txt",
    }
json.dump(config, sys.stdout)
