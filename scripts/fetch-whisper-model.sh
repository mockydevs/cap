#!/usr/bin/env bash
set -euo pipefail

# Public model artifacts only. Pin both the repository revision and the LFS SHA-256.
revision=5359861c739e955e79d9a303bcbc70fb988958b1
model=${1:-base.en}
destination=${2:?Usage: fetch-whisper-model.sh [tiny.en|base.en|small.en] /absolute/model-directory}
case "$destination" in /*) ;; *) echo 'Model directory must be absolute.' >&2; exit 2;; esac
case "$model" in
  tiny.en) checksum=921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f ;;
  base.en) checksum=a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002 ;;
  small.en) checksum=c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d ;;
  *) echo 'Supported models: tiny.en, base.en, small.en.' >&2; exit 2 ;;
esac
mkdir -p -- "$destination"
target="$destination/ggml-$model.bin"
verify() { printf '%s  %s\n' "$checksum" "$1" | sha256sum --check --status; }
if [[ -f "$target" ]] && verify "$target"; then
  echo "Verified existing ggml-$model.bin"
  exit 0
fi
partial=$(mktemp "$destination/.ggml-$model.XXXXXX")
trap 'rm -f -- "$partial"' EXIT
curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 20 --max-time 1800 \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/$revision/ggml-$model.bin?download=true" --output "$partial"
verify "$partial" || { echo 'Whisper model checksum mismatch; existing model was not replaced.' >&2; exit 1; }
chmod 0644 "$partial"
mv -- "$partial" "$target"
echo "Installed verified ggml-$model.bin"
