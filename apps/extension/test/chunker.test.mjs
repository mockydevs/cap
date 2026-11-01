// node --test apps/extension/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChunker } from "../src/chunker.js";

function harness({ stopDelayMs }) {
  let clock = 0;
  let timers = [];
  const chunks = [];
  const makeRecorder = () => {
    const r = {
      start() {},
      stop() {
        // Real browsers deliver data and onstop later, asynchronously.
        const fire = () => {
          r.ondataavailable({ data: { size: 10 } });
          r.onstop();
        };
        timers.push({ at: clock + stopDelayMs, fn: fire });
      },
    };
    return r;
  };
  const advance = async (ms) => {
    const target = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      clock = next.at;
      next.fn();
      await new Promise((r) => setImmediate(r));
    }
    clock = target;
  };
  const chunker = createChunker({
    chunkMs: 30_000,
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { at: clock + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      timers = timers.filter((x) => x !== t);
    },
    makeRecorder,
    onChunk: async (c) => {
      await new Promise((r) => setImmediate(r)); // e.g. hashing / IndexedDB
      chunks.push({ seq: c.seq, startMs: c.startMs, durationMs: c.durationMs });
    },
  });
  return { chunker, chunks, advance };
}

test("chunks are contiguous even when onstop fires after the next chunk starts", async () => {
  const { chunker, chunks, advance } = harness({ stopDelayMs: 250 });
  await advance(95_000);
  const p = chunker.stop();
  await advance(1_000);
  assert.deepEqual(await p, { lastSeq: 3 });
  assert.deepEqual(chunks, [
    { seq: 0, startMs: 0, durationMs: 30_000 },
    { seq: 1, startMs: 30_000, durationMs: 30_000 },
    { seq: 2, startMs: 60_000, durationMs: 30_000 },
    { seq: 3, startMs: 90_000, durationMs: 5_000 },
  ]);
});

test("a stop right after start still yields one chunk with a positive duration", async () => {
  const { chunker, chunks, advance } = harness({ stopDelayMs: 0 });
  const p = chunker.stop();
  await advance(10);
  await p;
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startMs, 0);
  assert.ok(chunks[0].durationMs >= 1);
});
