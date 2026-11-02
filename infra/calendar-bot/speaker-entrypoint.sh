#!/bin/sh
# TEST-ONLY synthetic speaker: private display and audio. Its microphone is
# a null sink's monitor that carries only the scripted file.
set -eu
allowed=" PATH LANG TZ CHROME_PATH FFMPEG_PATH CAP_SPEAKER_ALLOWED_CODE CAP_SPEAKER_SINK \
CAP_BOT_CHROME_NO_SANDBOX CAP_BOT_TEST_MEET_ORIGIN "
for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do
  case "$allowed" in
    *" $name "*) ;;
    *) unset "$name" 2>/dev/null || true ;;
  esac
done
export HOME=/tmp/home XDG_RUNTIME_DIR=/tmp/xdg DISPLAY=:98
mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
Xvfb :98 -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &
# cap_spk: the scripted audio; cap_spk_mic: its monitor remapped into a
# real input device (Chrome does not list monitor sources as microphones).
# spk_out: what the speaker hears, discarded.
pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit -n \
  --load="module-native-protocol-unix" \
  --load="module-null-sink sink_name=cap_spk" \
  --load="module-remap-source master=cap_spk.monitor source_name=cap_spk_mic" \
  --load="module-null-sink sink_name=spk_out"
i=0
until pactl info >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 50 ] && { echo "pulseaudio did not start" >&2; exit 1; }
  sleep 0.1
done
pactl set-default-sink spk_out
pactl set-default-source cap_spk_mic
exec /usr/local/bin/cap-meet-speaker --code "${CAP_SPEAKER_ALLOWED_CODE:-}" "$@"
