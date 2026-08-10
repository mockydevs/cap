#!/usr/bin/env bash
set -euo pipefail
target="${1:?target must be chromium or firefox}"
case "$target" in
  chromium) manifest="manifest.chromium.json" ;;
  firefox) manifest="manifest.firefox.json" ;;
  *) exit 2 ;;
esac
root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$root/src/$manifest" "$stage/manifest.json"
cp "$root/src/background.js" "$root/src/popup.html" "$root/src/popup.css" "$root/src/popup.js" "$stage/"
mkdir -p "$root/dist"
(cd "$stage" && zip -qr "$root/dist/cap-${target}-extension.zip" .)
