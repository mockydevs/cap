#!/usr/bin/env bash
# Builds the Rust detector to WASM and packages the extension.
# Output: target/extension/unpacked (load in chrome://extensions) and
# target/extension/cap-extension.zip.
#
# Local test builds can point at other servers (never use these overrides
# for a release):
#   CAP_SERVER_URL=http://127.0.0.1:8788 CALARI_ORIGIN=http://127.0.0.1:3000 ./build.sh
#
# Chrome Web Store upload: STORE=1 ./build.sh also writes
# target/extension/cap-extension-store_<version>.zip without the manifest
# "key" (the Store assigns the item's own ID; see docs/chrome-web-store/).
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
if [[ -n "${STORE:-}" ]]; then
  if [[ -n "${CAP_SERVER_URL:-}${CALARI_ORIGIN:-}" ]]; then
    echo "STORE=1 cannot be combined with test server overrides" >&2
    exit 1
  fi
  store="$out/store"
  rm -rf "$store" && cp -r "$out/unpacked" "$store"
  version="$(python3 - "$store/manifest.json" <<'PY'
import json, sys
p = sys.argv[1]
m = json.load(open(p))
m.pop("key", None)
open(p, "w").write(json.dumps(m, indent=2) + "\n")
print(m["version"])
PY
)"
  zip_path="$out/cap-extension-store_${version}.zip"
  rm -f "$zip_path"
  (cd "$store" && TZ=UTC find . -type f ! -name '.DS_Store' -exec touch -d '2026-01-01T00:00:00Z' {} + && find . -type f ! -name '.DS_Store' | LC_ALL=C sort | zip -qX "$zip_path" -@)
  echo "$zip_path"
fi
