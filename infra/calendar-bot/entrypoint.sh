#!/bin/sh
# Private display and audio for one runner; nothing is shared with the host.
set -eu

# Coolify injects the whole application environment (database, AWS, Google,
# integration secrets) into every container. Keep only what the runner needs,
# before anything else starts. Values never appear in arguments.
allowed=" PATH LANG TZ RUST_LOG CAP_SERVER_URL CHROME_PATH FFMPEG_PATH \
CAP_BOT_ENABLED CAP_BOT_RUNNER_TOKEN CAP_BOT_RUNNER_TOKEN_FILE CAP_BOT_ALLOW_HTTP \
CAP_BOT_SPOOL_DIR CAP_BOT_SPOOL_MAX_MB CAP_BOT_PROFILE_DIR CAP_BOT_PULSE_SINK \
CAP_BOT_CHROME_NO_SANDBOX CAP_BOT_TEST_MEET_ORIGIN CAP_BOT_HEARTBEAT_SECONDS \
CAP_BOT_WAITING_SECONDS CAP_BOT_PAGE_LOAD_SECONDS CAP_BOT_IDLE_WARNING_SECONDS \
CAP_BOT_IDLE_STOP_SECONDS "
for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do
  case "$allowed" in
    *" $name "*) ;;
    *) unset "$name" 2>/dev/null || true ;;
  esac
done

export HOME=/tmp/home XDG_RUNTIME_DIR=/tmp/xdg DISPLAY=:99
mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# The display and audio servers never see the runner token.
runner_token="${CAP_BOT_RUNNER_TOKEN-}"
unset CAP_BOT_RUNNER_TOKEN

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

# Only the runner gets it; it is non-dumpable and drops it from its own
# environment after reading, so FFmpeg and Chrome never inherit it.
if [ -n "$runner_token" ]; then
  CAP_BOT_RUNNER_TOKEN="$runner_token"
  export CAP_BOT_RUNNER_TOKEN
fi
unset runner_token
exec /usr/local/bin/cap-meeting-bot
