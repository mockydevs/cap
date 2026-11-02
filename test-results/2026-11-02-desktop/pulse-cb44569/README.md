# Pulse capture evidence at cb44569 (runtime unchanged since eaf6325)

- startup-trace.log: in a fresh PulseAudio (as in CI) the first Pulse stream opened delivers its first
  audio after ~1.4-2.0 s, then runs at real time; another source by name can start in 0.1 s. That
  start-up is not capturable audio.
- pulse-smoke-1..3: test measures each input's first-audio time first, then records 10 s and requires
  > = 3 segments AND recorded >= 10 s - measured start-up - 1 s. Kept 8017/8260/8262 ms with start-up
  > 1963/1467/1468 ms: all exit 0 (CAP_TEST_PULSE=1, real Pulse, not skipped).
- mutation-kill-instead-of-q: killing FFmpeg instead of "q" kept 6010 ms (< 7041 floor) -> exit 101.
- stop-keeps-audio / mutation-capture-after-stop: pipe test; normal run keeps the audio before Stop with
  the after-Stop tone absent; capturing 2 s after Stop fails it.
- Correction: my earlier "7 s of PulseAudio keeps about 6.9 s" referred to a direct single-input FFmpeg run
  writing raw output, not the recorder session. checks-082cff3 pulse-smoke 1-3 failed (exit 101, 4.9-5.3 s
  against my then 5.5 s floor) and are preserved unchanged. The full 6.1/8.0 suites skip the Pulse case
  unless CAP_TEST_PULSE=1; only pulse-smoke runs prove real Pulse.
