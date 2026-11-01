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
        try {
          await onChunk({
            seq: entry.seq,
            startMs: entry.startMs,
            durationMs: Math.max(1, entry.endMs - entry.startMs),
            parts: entry.parts,
          });
        } finally {
          resolve();
        }
      };
    });
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
    /// Stops recording; resolves once the final chunk has been handed over.
    async stop() {
      clearTimer(timer);
      const last = current;
      end(last, elapsed());
      await last.done;
      return { lastSeq: last.seq };
    },
  };
}
