#!/usr/bin/env bash
# Builds the Rust detector to WASM and packages the extension as a zip.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cargo build --manifest-path "$root/Cargo.toml" -p cap-meeting-detector-wasm --target wasm32-unknown-unknown --profile release-wasm
cp "$root/target/wasm32-unknown-unknown/release-wasm/cap_meeting_detector_wasm.wasm" "$here/src/detector.wasm"
mkdir -p "$root/target/extension"
out="$root/target/extension/cap-extension.zip"
rm -f "$out"
(cd "$here" && zip -qr "$out" manifest.json src -x '*.DS_Store')
echo "$out"
