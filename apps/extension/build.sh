#!/usr/bin/env bash
# Builds the Rust detector to WASM and packages the extension.
# Output: target/extension/unpacked (load in chrome://extensions) and
# target/extension/cap-extension.zip.
#
# Local test builds can point at other servers (never use these overrides
# for a release):
#   CAP_SERVER_URL=http://127.0.0.1:8788 CALARI_ORIGIN=http://127.0.0.1:3000 ./build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/target/extension"
cargo build --manifest-path "$root/Cargo.toml" -p cap-meeting-detector-wasm --target wasm32-unknown-unknown --profile release-wasm
rm -rf "$out/unpacked" && mkdir -p "$out/unpacked"
cp -r "$here/manifest.json" "$here/src" "$out/unpacked/"
cp "$root/target/wasm32-unknown-unknown/release-wasm/cap_meeting_detector_wasm.wasm" "$out/unpacked/src/detector.wasm"
if [[ -n "${CAP_SERVER_URL:-}${CALARI_ORIGIN:-}" ]]; then
  python3 - "$out/unpacked" "${CAP_SERVER_URL:-}" "${CALARI_ORIGIN:-}" <<'PY'
import json, sys, pathlib
d, cap, calari = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
cfg = d / "src/config.js"
text = cfg.read_text()
if cap:
    text = text.replace('"https://meetings.calari.tech"', json.dumps(cap.rstrip("/")))
if calari:
    text = text.replace('"https://calarisolutions.com"', json.dumps(calari.rstrip("/")))
cfg.write_text(text)
m = json.loads((d / "manifest.json").read_text())
for origin in filter(None, [cap, calari]):
    m["host_permissions"].append(origin.rstrip("/") + "/*")
(d / "manifest.json").write_text(json.dumps(m, indent=2) + "\n")
print("TEST BUILD: config overridden", file=sys.stderr)
PY
fi
rm -f "$out/cap-extension.zip"
(cd "$out/unpacked" && zip -qr "$out/cap-extension.zip" . -x '*.DS_Store')
echo "$out/unpacked"
echo "$out/cap-extension.zip"
