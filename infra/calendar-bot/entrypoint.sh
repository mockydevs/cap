#!/bin/sh
# Private display and audio for one runner; nothing is shared with the host.
set -eu
export HOME=/tmp/home XDG_RUNTIME_DIR=/tmp/xdg DISPLAY=:99
mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &
# cap_bot: what the meeting sounds like (recorded from its monitor).
# cap_mic: a silent microphone, so the bot never sends sound.
pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit -n \
  --load="module-native-protocol-unix" \
  --load="module-null-sink sink_name=cap_bot" \
  --load="module-null-sink sink_name=cap_mic"
i=0
until pactl info >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 50 ] && { echo "pulseaudio did not start" >&2; exit 1; }
  sleep 0.1
done
pactl set-default-sink cap_bot
pactl set-default-source cap_mic.monitor
exec /usr/local/bin/cap-meeting-bot
