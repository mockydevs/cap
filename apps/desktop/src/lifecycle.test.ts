import { describe, expect, it } from "vitest";
import type { MeetingOptions, PairInfo } from "./api";
import {
  type Lifecycle,
  type LifecycleAction,
  initialLifecycle,
  lifecycle,
  startFromForm,
  startFromLink,
} from "./lifecycle";

const options: MeetingOptions = {
  title: "Meeting notes",
  mode: "audio",
  systemAudio: true,
};
const info: PairInfo = {
  serverUrl: "https://meetings.example",
  pairingKind: "client_intake",
  clientName: "Acme",
  expiresAt: "2026-11-02T10:00:00Z",
};

/** The window's state, changed only by dispatched actions, in order. */
function store() {
  let state: Lifecycle = initialLifecycle;
  return {
    dispatch: (a: LifecycleAction) => {
      state = lifecycle(state, a);
    },
    get recording() {
      return state.recording;
    },
  };
}

/** A start call that returns only when the test says so. */
function delayedStart() {
  let finish!: (id: string) => void;
  const called: MeetingOptions[] = [];
  const start = (o: MeetingOptions) => {
    called.push(o);
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  };
  return { start, called, finish: (id: string) => finish(id) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("meeting lifecycle", () => {
  it("shows the meeting as recording when it starts", async () => {
    const s = store();
    const call = delayedStart();
    const done = startFromForm(
      { start: call.start, dispatch: s.dispatch },
      options,
    );
    await tick();
    expect(s.recording).toBeNull();
    call.finish("m1");
    await done;
    expect(s.recording).toBe("m1");
    s.dispatch({ type: "stopped", id: "m1" });
    expect(s.recording).toBeNull();
  });

  it("a stop seen before the start returns wins (Start recording)", async () => {
    const s = store();
    const call = delayedStart();
    const done = startFromForm(
      { start: call.start, dispatch: s.dispatch },
      options,
    );
    await tick();
    expect(call.called).toHaveLength(1);
    s.dispatch({ type: "stopped", id: "m1" });
    call.finish("m1");
    await done;
    expect(s.recording).toBeNull();
  });

  it("a stop seen before the start returns wins (Add note taker link)", async () => {
    const s = store();
    const call = delayedStart();
    const paired: string[] = [];
    const done = startFromLink(
      {
        start: call.start,
        dispatch: s.dispatch,
        pair: async (code) => {
          paired.push(code);
          return info;
        },
        onPaired: () => {},
      },
      { code: "7KQ2-M9XD", mode: "audio" },
      options,
    );
    await tick();
    expect(paired).toEqual(["7KQ2-M9XD"]);
    expect(call.called).toHaveLength(1);
    s.dispatch({ type: "stopped", id: "m1" });
    call.finish("m1");
    await done;
    expect(s.recording).toBeNull();
  });

  it("a stop for another meeting never clears the one shown", () => {
    let state = lifecycle(initialLifecycle, { type: "started", id: "m2" });
    state = lifecycle(state, { type: "stopped", id: "m1" });
    expect(state.recording).toBe("m2");
    // The earlier meeting's late start does not take over either.
    state = lifecycle(state, { type: "started", id: "m1" });
    expect(state.recording).toBe("m2");
  });
});
