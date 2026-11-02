#!/usr/bin/env bash
# First-audio latency per Pulse source in a fresh PulseAudio (as in CI), FFmpeg flushing per packet.
export XDG_RUNTIME_DIR=$(mktemp -d)
pulseaudio --daemonize=yes --exit-idle-time=-1 -n --load=module-native-protocol-unix --load="module-null-sink sink_name=speakers" --load="module-null-sink sink_name=mic"
sleep 1; pactl set-default-sink speakers; pactl set-default-source mic.monitor
ffmpeg -nostdin -loglevel error -re -f lavfi -i "sine=frequency=330:duration=300" -f pulse -device mic mic &
ffmpeg -nostdin -loglevel error -re -f lavfi -i "sine=frequency=550:duration=300" -f pulse -device speakers speakers &
sleep 1
python3 - <<'PY'
import subprocess, time
for label, src in [("microphone (default)", "default"), ("speakers monitor (@DEFAULT_MONITOR@)", "@DEFAULT_MONITOR@"), ("speakers monitor by name", "speakers.monitor")]:
    t0 = time.monotonic()
    p = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-f", "pulse", "-i", src, "-ac", "1", "-ar", "16000", "-flush_packets", "1", "-f", "s16le", "-"], stdout=subprocess.PIPE, stdin=subprocess.DEVNULL)
    p.stdout.read(320); t1 = time.monotonic() - t0
    got = 0; end = time.monotonic() + 3
    while time.monotonic() < end: got += len(p.stdout.read(3200))
    p.kill(); p.wait()
    print(f"{label:40s} first audio after {t1:.2f}s, then {got/32000/3:.2f}x real time")
PY
