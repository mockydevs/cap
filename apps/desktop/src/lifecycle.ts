import type { MeetingOptions, NoteTakerLink, PairInfo } from "./api";

/**
 * Which meeting the window shows as recording. Every change goes through
 * `lifecycle`, one action at a time, in the order they happen. A meeting
 * that was seen to stop stays stopped: if its Stopped event arrives before
 * the start call returns, the late start is ignored, so the window never
 * shows a recording that has already ended. A stop for another meeting
 * never clears the one shown.
 */
export type Lifecycle = {
  recording: string | null;
  ended: readonly string[];
};

export type LifecycleAction =
  { type: "started"; id: string } | { type: "stopped"; id: string };

export const initialLifecycle: Lifecycle = { recording: null, ended: [] };

export function lifecycle(
  state: Lifecycle,
  action: LifecycleAction,
): Lifecycle {
  switch (action.type) {
    case "started":
      return state.ended.includes(action.id)
        ? state
        : { ...state, recording: action.id };
    case "stopped":
      return {
        recording: state.recording === action.id ? null : state.recording,
        // Only the latest few matter: a start returns within seconds.
        ended: [...state.ended.slice(-19), action.id],
      };
  }
}

export type StartDeps = {
  start: (options: MeetingOptions) => Promise<string>;
  dispatch: (action: LifecycleAction) => void;
};

/** "Start recording" in the window. */
export async function startFromForm(
  deps: StartDeps,
  options: MeetingOptions,
): Promise<void> {
  const id = await deps.start(options);
  deps.dispatch({ type: "started", id });
}

/** "Add note taker" link from Calari: pair, then start. */
export async function startFromLink(
  deps: StartDeps & {
    pair: (code: string) => Promise<PairInfo>;
    onPaired: (info: PairInfo, link: NoteTakerLink) => void;
  },
  link: NoteTakerLink,
  options: MeetingOptions,
): Promise<void> {
  const info = await deps.pair(link.code);
  deps.onPaired(info, link);
  const id = await deps.start(options);
  deps.dispatch({ type: "started", id });
}
