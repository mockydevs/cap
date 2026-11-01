// Records the captured tab (plus the user's microphone, if granted) in
// standalone 30-second chunks, keeps the call audible, and asks the Rust
// detector (detector.wasm) whether to warn or stop.

import {
  CHUNK_MS,
  SIGNAL,
  STOP_REASONS,
  putChunk,
  deleteChunk,
  pendingChunks,
  sha256Hex,
  uploadChunk,
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
    } catch (e) {
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

  rec = {
    meetingId: msg.meetingId,
    server: msg.server,
    token: msg.token,
    mime: pickMime(video),
    stream,
    tab,
    mic,
    ctx,
    analyser,
    detector,
    seq: msg.nextSeq ?? 0,
    offsetMs: msg.offsetMs ?? 0,
    recorder: null,
    chunkTimer: null,
    tickTimer: null,
    uploading: false,
    stopping: false,
    lastWarn: 0,
  };
  for (const track of tab.getTracks())
    track.onended = () => signal(SIGNAL.tabClosed);
  if (mic)
    for (const track of mic.getTracks())
      track.onended = () => signal(SIGNAL.deviceLost);
  nextChunk();
  rec.tickTimer = setInterval(tick, 500);
}

function nextChunk() {
  const r = rec;
  if (!r || r.stopping) return;
  // A fresh MediaRecorder per chunk makes every chunk a complete, decodable
  // file; the gap between recorders is a few milliseconds.
  const recorder = new MediaRecorder(r.stream, {
    mimeType: r.mime,
    audioBitsPerSecond: 64_000,
    videoBitsPerSecond: 1_500_000,
  });
  const startedAt = performance.now();
  const seq = r.seq++;
  const startMs = r.offsetMs;
  const parts = [];
  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  recorder.onstop = async () => {
    const durationMs = Math.round(performance.now() - startedAt);
    r.offsetMs = startMs + durationMs;
    const blob = new Blob(parts, { type: r.mime.split(";")[0] });
    if (blob.size) {
      await putChunk({
        meetingId: r.meetingId,
        seq,
        startMs,
        durationMs,
        blob,
        sha256: await sha256Hex(blob),
      });
      r.lastSeq = seq;
      drain();
    } else {
      r.seq = Math.min(r.seq, seq); // nothing captured; reuse the number
    }
    r.onChunkStored?.();
  };
  recorder.start();
  r.recorder = recorder;
  r.chunkTimer = setTimeout(() => {
    nextChunk();
    recorder.stop();
  }, CHUNK_MS);
}

async function drain() {
  const r = rec;
  if (!r || r.uploading) return;
  r.uploading = true;
  try {
    for (const c of await pendingChunks(r.meetingId)) {
      if (await uploadChunk(r.server, r.token, c))
        await deleteChunk(c.meetingId, c.seq);
      else break; // offline or server busy: keep it, retry on the next chunk or tick
    }
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
    stop(STOP_REASONS[r.detector.detector_reason_code()] ?? "user_stopped");
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
  if (!r || r.stopping) return;
  r.stopping = true;
  clearInterval(r.tickTimer);
  clearTimeout(r.chunkTimer);
  const stored = new Promise((resolve) => (r.onChunkStored = resolve));
  if (r.recorder?.state === "recording") {
    r.recorder.stop();
    await Promise.race([stored, new Promise((res) => setTimeout(res, 5_000))]);
  }
  for (const t of [...r.tab.getTracks(), ...(r.mic?.getTracks() ?? [])])
    t.stop();
  await r.ctx.close().catch(() => {});
  // Give uploads up to a minute; anything left is retried by the service worker.
  const deadline = Date.now() + 60_000;
  while ((await pendingChunks(r.meetingId)).length && Date.now() < deadline) {
    r.uploading = false;
    await drain();
    if ((await pendingChunks(r.meetingId)).length)
      await new Promise((res) => setTimeout(res, 3_000));
  }
  rec = null;
  chrome.runtime.sendMessage({
    type: "offscreen-stopped",
    meetingId: r.meetingId,
    reason,
    lastSeq: r.seq - 1,
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
        return { recording: !!rec, meetingId: rec?.meetingId ?? null };
      default:
        return { ok: false };
    }
  })().then(reply, (e) => reply({ ok: false, error: String(e?.message ?? e) }));
  return true;
});
