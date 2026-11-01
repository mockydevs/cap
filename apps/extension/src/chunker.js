// Splits one recording into standalone chunks timed from a single clock.
//
// A fresh MediaRecorder per chunk makes every chunk a complete file. The
// boundary time is taken once, when the switch happens, and used as both the
// end of the old chunk and the start of the new one, so chunk times never
// depend on when the browser gets round to firing the old recorder's
// `onstop` (which is asynchronous and can land after the next chunk started).

export function createChunker({
  chunkMs,
  now,
  setTimer,
  clearTimer,
  makeRecorder,
  onChunk,
  startSeq = 0,
  baseOffsetMs = 0,
}) {
  const origin = now();
  const elapsed = () => baseOffsetMs + Math.round(now() - origin);
  let seq = startSeq;
  let current = null;
  let timer = null;
  const pending = new Set();
  const failed = new Map();
  let stopped = false;
  let stopTask = null;

  async function save(chunk) {
    try {
      await onChunk(chunk);
      failed.delete(chunk.seq);
    } catch (error) {
      // Keep the exact bytes and timing until a later Stop retries storage.
      failed.set(chunk.seq, { chunk, error });
    }
  }

  function begin(startMs) {
    const entry = {
      seq: seq++,
      startMs,
      endMs: null,
      parts: [],
      recorder: makeRecorder(),
    };
    entry.done = new Promise((resolve) => {
      entry.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) entry.parts.push(e.data);
      };
      entry.recorder.onstop = async () => {
        await save({
          seq: entry.seq,
          startMs: entry.startMs,
          durationMs: Math.max(1, entry.endMs - entry.startMs),
          parts: entry.parts,
        });
        pending.delete(entry.done);
        resolve();
      };
    });
    pending.add(entry.done);
    entry.recorder.start();
    current = entry;
    timer = setTimer(rollover, chunkMs);
  }

  function end(entry, at) {
    entry.endMs = at;
    entry.recorder.stop();
  }

  function rollover() {
    const at = elapsed();
    const previous = current;
    begin(at);
    end(previous, at);
  }

  begin(elapsed());

  return {
    // A retry never restarts capture or allocates another sequence number.
    stop() {
      if (stopTask) return stopTask;
      const retry = stopped;
      if (!stopped) {
        stopped = true;
        clearTimer(timer);
        end(current, elapsed());
      }
      stopTask = (async () => {
        await Promise.all([...pending]);
        if (retry)
          await Promise.all([...failed.values()].map(({ chunk }) => save(chunk)));
        if (failed.size) throw failed.values().next().value.error;
        return { lastSeq: current.seq };
      })().finally(() => { stopTask = null; });
      return stopTask;
    },
  };
}
