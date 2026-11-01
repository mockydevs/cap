// Records the captured tab (plus the user's microphone, if granted) in
// standalone 30-second chunks, keeps the call audible, and asks the Rust
// detector (detector.wasm) whether to warn or stop.

import { createChunker } from "./chunker.js";
import {
  CHUNK_MS,
  SIGNAL,
  STOP_REASONS,
  drainMeeting,
  putChunk,
  sha256Hex,
} from "./shared.js";

let rec = null; // current recording session

async function loadDetector() {
  const bytes = await (
    await fetch(chrome.runtime.getURL("src/detector.wasm"))
  ).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}

function pickMime(video) {
  const options = video
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["audio/webm;codecs=opus", "audio/webm"];
  return options.find((m) => MediaRecorder.isTypeSupported(m));
}

async function start(msg) {
  if (rec) throw new Error("already recording");
  const video = msg.mode === "video";
  const tabConstraint = {
    mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId },
  };
  const tab = await navigator.mediaDevices.getUserMedia({
    audio: tabConstraint,
    video: video ? tabConstraint : false,
  });

  const ctx = new AudioContext();
  const mix = ctx.createMediaStreamDestination();
  const tabSource = ctx.createMediaStreamSource(tab);
  // Capturing a tab mutes it; route it back out so the call stays audible.
  tabSource.connect(ctx.destination);
  tabSource.connect(mix);
  let mic = null;
  if (msg.useMic) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      ctx.createMediaStreamSource(mic).connect(mix); // not to speakers: no echo
    } catch {
      chrome.runtime.sendMessage({
        type: "offscreen-notice",
        text: "Microphone not available; recording the meeting tab only. Grant it in Cap options.",
      });
    }
  }
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(mix.stream).connect(analyser);

  const stream = new MediaStream([
    ...mix.stream.getAudioTracks(),
    ...tab.getVideoTracks(),
  ]);
  const detector = await loadDetector();
  detector.detector_start(
    Date.now(),
    msg.idleWarningMs ?? 0,
    msg.idleStopMs ?? 0,
    msg.hardMaxMs ?? 0,
  );
  const mime = pickMime(video);

  rec = {
    meetingId: msg.meetingId,
    server: msg.server,
    token: msg.token,
    tab,
    mic,
    ctx,
    analyser,
    detector,
    uploading: false,
    stopping: false,
    lastWarn: 0,
    tickTimer: null,
  };
  const r = rec;
  r.chunker = createChunker({
    chunkMs: CHUNK_MS,
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
    makeRecorder: () =>
      new MediaRecorder(stream, {
        mimeType: mime,
        audioBitsPerSecond: 64_000,
        videoBitsPerSecond: 1_500_000,
      }),
    startSeq: msg.nextSeq ?? 0,
    baseOffsetMs: msg.offsetMs ?? 0,
    onChunk: async ({ seq, startMs, durationMs, parts }) => {
      const blob = new Blob(parts, { type: mime.split(";")[0] });
      if (blob.size === 0) {
        // Nothing was captured for this slot; record that so finalize can
        // accept the gap instead of waiting for audio that never existed.
        await putChunk({
          meetingId: r.meetingId,
          seq,
          startMs,
          durationMs,
          blob,
          sha256: "",
          quarantined: true,
          empty: true,
        });
        return;
      }
      await putChunk({
        meetingId: r.meetingId,
        seq,
        startMs,
        durationMs,
        blob,
        sha256: await sha256Hex(blob),
      });
      drain();
    },
  });
  for (const track of tab.getTracks())
    track.onended = () => signal(SIGNAL.tabClosed);
  if (mic)
    for (const track of mic.getTracks())
      track.onended = () => signal(SIGNAL.deviceLost);
  r.tickTimer = setInterval(tick, 500);
}

async function drain() {
  const r = rec;
  if (!r || r.uploading) return "busy";
  r.uploading = true;
  try {
    return await drainMeeting(r.server, r.token, r.meetingId);
  } finally {
    r.uploading = false;
  }
}

function level(analyser) {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  return Math.sqrt(sum / buf.length);
}

function tick() {
  const r = rec;
  if (!r || r.stopping) return;
  const now = Date.now();
  r.detector.detector_feed_rms(now, level(r.analyser));
  const decision = r.detector.detector_tick(now);
  if (decision === 1 && now - r.lastWarn > 30_000) {
    r.lastWarn = now;
    chrome.runtime.sendMessage({
      type: "offscreen-warn",
      reason: r.detector.detector_reason_code(),
      stopAtMs: r.detector.detector_stop_at_ms(),
      meetingId: r.meetingId,
    });
  } else if (decision === 2) {
    // Failed saves already publish retry state to the service worker.
    void stop(
      STOP_REASONS[r.detector.detector_reason_code()] ?? "user_stopped",
    ).catch(() => {});
  }
  if (now % 10_000 < 500) drain();
}

function signal(code) {
  if (!rec) return;
  rec.detector.detector_signal(Date.now(), code);
  tick();
}

async function stop(reason) {
  const r = rec;
  if (!r) return;
  if (r.saving) throw new Error("Audio is still being saved. Please wait.");
  r.saving = true;
  r.stopping = true;
  clearInterval(r.tickTimer);
  const saved = r.chunker.stop().then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  // Release capture even when storage is full. The chunker retains failed
  // bytes in this offscreen document and Stop can retry saving them.
  for (const t of [...r.tab.getTracks(), ...(r.mic?.getTracks() ?? [])])
    t.stop();
  await r.ctx.close().catch(() => {});
  let lastSeq;
  try {
    const outcome = await saved;
    if (outcome.error) throw outcome.error;
    ({ lastSeq } = outcome.result);
  } catch {
    const message =
      "Recording stopped, but browser storage could not save all audio. Keep Chrome open, free disk space, then click Retry saving. Unsaved audio is kept in this browser session.";
    await chrome.runtime
      .sendMessage({
        type: "offscreen-save-failed",
        meetingId: r.meetingId,
        error: message,
      })
      .catch(() => {});
    throw new Error(message);
  } finally {
    r.saving = false;
  }
  rec = null;
  // The service worker persists unfinished state before attempting delivery.
  // Do not leave the UI showing Recording while network retries run.

  chrome.runtime.sendMessage({
    type: "offscreen-stopped",
    meetingId: r.meetingId,
    reason,
    lastSeq,
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.target !== "offscreen") return;
  (async () => {
    switch (msg.type) {
      case "start":
        await start(msg);
        return { ok: true };
      case "signal":
        signal(msg.code);
        return { ok: true };
      case "stop":
        await stop(msg.reason ?? "user_stopped");
        return { ok: true };
      case "status":
        return {
          recording: !!rec && !rec.stopping,
          pendingSave: !!rec?.stopping,
          meetingId: rec?.meetingId ?? null,
        };
      default:
        return { ok: false };
    }
  })().then(reply, (e) => reply({ ok: false, error: String(e?.message ?? e) }));
  return true;
});
