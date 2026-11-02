import os, subprocess, tempfile, time
def trace(label, inputs, filt, opus=True, seg_extra=()):
    d = tempfile.mkdtemp()
    outs = (["-map", "[rec]", "-c:a", "libopus", "-b:a", "48k", "-f", "segment", "-segment_time", "2",
             "-flush_packets", "1", *seg_extra, "-segment_format", "ogg", os.path.join(d, "seg_%03d.ogg")] if opus
            else ["-map", "[rec]", "-f", "null", "-"])
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", filt, *outs,
           "-map", "[vad]", "-ac", "1", "-ar", "16000", "-flush_packets", "1", "-f", "s16le", "pipe:1"]
    t0 = time.monotonic(); p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    marks, got = [], 0
    while time.monotonic() - t0 < 7:
        b = p.stdout.read(1600)
        if not b: break
        got += len(b); marks.append((time.monotonic() - t0, got / 32000))
    p.stdin.write(b"q"); p.stdin.flush(); p.wait()
    pts = " ".join(f"{w:.1f}:{a:.1f}" for w, a in marks[:: max(1, len(marks) // 7)])
    print(f"{label:30s} first pcm {marks[0][0]:.2f}s | wall:audio {pts} | at 7s {got/32000:.2f}s")
one = "[0:a]asplit=2[rec][vad]"
mix = "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0,asplit=2[rec][vad]"
p1 = ["-f", "pulse", "-i", "default"]; p2 = p1 + ["-f", "pulse", "-i", "@DEFAULT_MONITOR@"]
FS = ["-fragment_size", "3840"]
trace("@DEFAULT_MONITOR@ alone, fragment 3840", ["-f", "pulse", *FS, "-i", "@DEFAULT_MONITOR@"], one, opus=False)
trace("2 pulse, fragment 3840 each", ["-f", "pulse", *FS, "-i", "default", "-f", "pulse", *FS, "-i", "@DEFAULT_MONITOR@"], mix, opus=False)
trace("2 pulse, fragment 3840, opus page20", ["-f", "pulse", *FS, "-i", "default", "-f", "pulse", *FS, "-i", "@DEFAULT_MONITOR@"], mix, seg_extra=("-segment_format_options", "page_duration=20000"))
