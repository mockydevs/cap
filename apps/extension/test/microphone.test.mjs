import { test } from "node:test";
import assert from "node:assert/strict";

// The offscreen recorder never falls back to the tab alone when the person
// asked for their microphone too.
let listener;
let micAllowed = false;
const tabTrack = {
  stopped: false,
  stop() {
    this.stopped = true;
  },
};
const tabStream = {
  getTracks: () => [tabTrack],
  getAudioTracks: () => [tabTrack],
  getVideoTracks: () => [],
};
const micTrack = {
  stopped: false,
  stop() {
    this.stopped = true;
  },
};
let contextClosed = false;
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => (listener = fn) },
    sendMessage: async () => {},
    getURL: (p) => `https://extension.test/${p}`,
  },
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      async getUserMedia(c) {
        if (c.audio?.mandatory?.chromeMediaSource === "tab") return tabStream;
        if (!micAllowed)
          throw Object.assign(new Error("Permission dismissed"), {
            name: "NotAllowedError",
          });
        return { getTracks: () => [micTrack] };
      },
    },
  },
});
const node = () => ({ connect() {} });
globalThis.AudioContext = class {
  destination = {};
  createMediaStreamDestination() {
    return { stream: { getAudioTracks: () => [] } };
  }
  createMediaStreamSource() {
    return node();
  }
  async close() {
    contextClosed = true;
  }
};
await import("../src/offscreen.js");
const send = (msg) =>
  new Promise((resolve) =>
    listener({ target: "offscreen", ...msg }, {}, resolve),
  );

test("mic-check reports a refusal and a grant, releasing the test stream", async () => {
  micAllowed = false;
  assert.deepEqual(await send({ type: "mic-check" }), {
    ok: false,
    error: "NotAllowedError",
  });
  micAllowed = true;
  assert.deepEqual(await send({ type: "mic-check" }), { ok: true });
  assert.equal(micTrack.stopped, true);
});

test("Start fails and releases the tab when the requested microphone is refused", async () => {
  micAllowed = false;
  const r = await send({
    type: "start",
    streamId: "synthetic",
    mode: "audio",
    meetingId: "m1",
    useMic: true,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not open your microphone/);
  assert.equal(tabTrack.stopped, true);
  assert.equal(contextClosed, true);
  assert.deepEqual(await send({ type: "status" }), {
    recording: false,
    pendingSave: false,
    meetingId: null,
  });
});
