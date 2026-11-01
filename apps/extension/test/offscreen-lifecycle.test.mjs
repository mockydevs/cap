import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;

for (const automatic of [false, true]) {
test(`${automatic ? "rollover quota failure auto-stops without user action" : "manual Stop quota failure"}; retry preserves bytes and finalizes once`, async (t) => {
  const listeners = [];
  let retryObserved;
  const event = () => ({ addListener() {} });
  const send = (message) => new Promise((resolve, reject) => {
    if (message.target === "offscreen" && message.type === "stop") retryObserved?.();
    let handled = false;
    for (const fn of listeners) handled = fn(message, {}, resolve) || handled;
    if (!handled) reject(new Error("No message handler"));
  });
  const store = {
    device: { token: "test-only", expiresAt: "2099-01-01" },
    server: "http://127.0.0.1:8789", options: { useMic: false },
  };
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      onStartup: event(), onInstalled: event(), sendMessage: send,
      getURL: (path) => `https://extension.test/${path}`,
    },
    storage: { local: {
      async get(key) { return { [key]: store[key] }; },
      async set(value) { Object.assign(store, value); },
      async remove(keys) { for (const key of [keys].flat()) delete store[key]; },
    } },
    offscreen: { async hasDocument() { return true; } },
    tabs: { async get() { return { title: "Synthetic", url: "http://127.0.0.1:8844" }; }, onRemoved: event(), onUpdated: event() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    notifications: { onButtonClicked: event(), create() {} },
    commands: { onCommand: event() }, alarms: { onAlarm: event() },
  };
  let quotaFull = true;
  const rolloverTimers = new Map();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    if (ms !== 30_000) return originalSetTimeout(fn, ms, ...args);
    const timer = {};
    rolloverTimers.set(timer, fn);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    if (!rolloverTimers.delete(timer)) originalClearTimeout(timer);
  });
  const records = new Map();
  const savedChunks = [];
  globalThis.indexedDB = { open() {
    const request = {};
    queueMicrotask(() => {
      request.result = { transaction() {
        const tx = { objectStore: () => ({
          put(chunk) {
            if (quotaFull) tx.error = new Error("QuotaExceededError");
            else { records.set(chunk.seq, chunk); savedChunks.push(chunk); }
          },
          getAll: () => ({ result: [...records.values()] }),
          delete(key) { records.delete(key[1]); },
        }) };
        queueMicrotask(() => tx.error ? tx.onerror() : tx.oncomplete());
        return tx;
      } };
      request.onsuccess();
    });
    return request;
  } };
  let captures = 0;
  const track = { stopped: false, stop() { this.stopped = true; this.onended?.(); } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {
    async getUserMedia(constraints) {
      captures++;
      assert.equal(constraints.audio.mandatory.chromeMediaSource, "tab");
      return stream;
    },
  } } });
  let contextClosed = false;
  let releaseClose;
  const closing = automatic ? new Promise((resolve) => { releaseClose = resolve; }) : Promise.resolve();
  globalThis.AudioContext = class {
    destination = {};
    createMediaStreamDestination() { return { stream }; }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { getFloatTimeDomainData() {} }; }
    async close() { contextClosed = true; await closing; }
  };
  globalThis.MediaStream = class { constructor() { return stream; } };
  let starts = 0;
  const original = new Blob(["original synthetic audio"], { type: "audio/webm" });
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return true; }
    start() { starts++; }
    stop() { queueMicrotask(() => { this.ondataavailable({ data: original }); this.onstop(); }); }
  };
  WebAssembly.instantiate = async () => ({ instance: { exports: { detector_start() {}, detector_signal() {}, detector_feed_rms() {}, detector_tick() { return 0; } } } });
  const uploads = [];
  const finalized = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("detector.wasm")) return new Response(new Uint8Array());
    if (url.endsWith("/v1/meetings")) return new Response('{"id":"synthetic"}');
    if (url.includes("/chunks/")) { uploads.push(options.body); return new Response("{}"); }
    if (url.endsWith("/finalize")) { finalized.push(JSON.parse(options.body)); return new Response("{}"); }
    throw new Error("Unexpected request " + url);
  };
  await import(`../src/background.js?automatic=${automatic}`);
  await import(`../src/offscreen.js?automatic=${automatic}`);
  t.after(async () => { releaseClose?.(); quotaFull = false; await send({ type: "stop" }).catch(() => {}); });
  const started = await send({ type: "start", tabId: 1, streamId: "synthetic", mode: "audio" });
  assert.equal(started.ok, true, started.error);
  if (automatic) {
    assert.equal(rolloverTimers.size, 1);
    const [timer, rollover] = rolloverTimers.entries().next().value;
    rolloverTimers.delete(timer);
    rollover();
    for (let n = 0; n < 50 && !store.active?.saveError; n++)
      await new Promise((resolve) => setImmediate(resolve));
    // No user Stop was sent: the first failed rollover must stop capture.
    assert.equal(rolloverTimers.size, 0);
    assert.equal(starts, 2);
  } else {
    const failure = await send({ type: "stop" });
    assert.equal(failure.ok, false);
    assert.match(failure.error, /Retry saving/);
  }
  assert.equal(track.stopped, true);
  assert.equal(contextClosed, true);
  assert.equal(store.active.pendingSave, true);
  assert.match(store.active.saveError, /Keep Chrome open/);
  assert.equal(uploads.length, 0);
  assert.equal(finalized.length, 0);
  const status = await send({ target: "offscreen", type: "status" });
  assert.equal(status.recording, false);
  assert.equal(status.pendingSave, true);
  quotaFull = false;
  // Concurrent Stop/retry gestures share the same save operation.
  const dispatched = new Promise((resolve) => { retryObserved = resolve; });
  const retryResults = Promise.all([send({ type: "stop" }), send({ type: "stop" })]);
  // Force the reported race: Retry reaches offscreen while original shutdown
  // is blocked in AudioContext.close, then let shutdown finish (no sleeps).
  await dispatched;
  releaseClose?.();
  const retries = await retryResults;
  assert.ok(retries.every((reply) => reply.ok));
  for (let n = 0; n < 50 && !finalized.length; n++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captures, 1);
  assert.equal(starts, automatic ? 2 : 1);
  assert.equal(rolloverTimers.size, 0);
  assert.equal(savedChunks.length, automatic ? 2 : 1);
  assert.equal(await savedChunks[0].blob.text(), await original.text());
  assert.deepEqual(savedChunks.map((chunk) => chunk.seq).sort(), automatic ? [0, 1] : [0]);
  assert.ok(uploads.length >= 1);
  assert.equal(await uploads[0].text(), await original.text());
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].last_seq, automatic ? 1 : 0);
  assert.equal(finalized[0].stop_reason, automatic ? "interrupted" : "user_stopped");
  for (const chunk of savedChunks) assert.equal(await chunk.blob.text(), await original.text());
  assert.equal(finalized[0].allow_missing, false);
  assert.equal(store.active, undefined);
});

}
