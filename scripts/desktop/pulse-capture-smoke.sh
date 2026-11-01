#!/usr/bin/env bash
# Linux capture smoke test with synthetic audio only (no real microphone).
# Starts a private PulseAudio with two virtual devices: "mic" (default
# source = its monitor) and "speakers" (default sink), plays a tone into
# each, then runs the recorder's Pulse integration test against them.
# Needs: pulseaudio, pactl, ffmpeg, CAP_TEST_DATABASE_URL.
set -euo pipefail
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$(mktemp -d)}"
pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit -n \
  --load="module-native-protocol-unix" --load="module-null-sink sink_name=speakers" \
  --load="module-null-sink sink_name=mic"
trap 'pulseaudio --kill || true; kill $(jobs -p) 2>/dev/null || true' EXIT
for _ in $(seq 50); do pactl info >/dev/null 2>&1 && break; sleep 0.1; done
pactl set-default-sink speakers
pactl set-default-source mic.monitor
ffmpeg -nostdin -loglevel error -re -f lavfi -i "sine=frequency=330:duration=60" -f pulse -device mic mic &
ffmpeg -nostdin -loglevel error -re -f lavfi -i "sine=frequency=550:duration=60" -f pulse -device speakers speakers &
sleep 1
CAP_TEST_PULSE=1 CAP_TEST_FFMPEG="${CAP_TEST_FFMPEG:-ffmpeg}" \
  cargo test -p cap-meeting-recorder --test capture linux_records_the_microphone_and_the_speakers_through_pulse -- --nocapture
