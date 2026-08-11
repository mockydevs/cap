#!/usr/bin/env bash
set -euo pipefail
target="${1:?target must be chromium or firefox}"
case "$target" in
  chromium) manifest="manifest.chromium.json" ;;
  firefox) manifest="manifest.firefox.json" ;;
  *) exit 2 ;;
esac
root="$(cd "$(dirname "$0")/.." && pwd)"

node "$root/scripts/build-shared.mjs"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$root/src/$manifest" "$stage/manifest.json"
cp "$root/src/popup.css" "$stage/"
cp "$root/src/icon16.png" "$root/src/icon48.png" "$root/src/icon128.png" "$stage/"

if [ "$target" = "firefox" ]; then
  cp "$root/src/background.firefox.js" "$stage/background.js"
  cp "$root/src/popup.firefox.html" "$stage/popup.html"
  cp "$root/src/popup.firefox.js" "$stage/popup.js"
else
  cp "$root/src/background.chromium.js" "$stage/background.js"
  cp "$root/src/popup.chromium.html" "$stage/popup.html"
  cp "$root/src/popup.chromium.js" "$stage/popup.js"
  cp "$root/src/offscreen.html" "$root/src/offscreen.js" "$stage/"
  cp "$root/src/controls.html" "$root/src/controls.js" "$stage/"
  mkdir -p "$stage/lib" "$stage/vendor"
  cp "$root/src/lib/"*.js "$stage/lib/"
  cp "$root/src/vendor/"*.js "$stage/vendor/"
fi

mkdir -p "$root/dist"
(cd "$stage" && zip -qr "$root/dist/cap-${target}-extension.zip" .)
