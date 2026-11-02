import { listen } from "@tauri-apps/api/event";
import { useEffect, useReducer, useState } from "react";
import {
  meeting,
  type AudioDevices,
  type MeetingEvent,
  type NoteTakerLink,
  type PairInfo,
} from "./api";
import {
  initialLifecycle,
  lifecycle,
  startFromForm,
  startFromLink,
} from "./lifecycle";

const stopText: Record<string, string> = {
  user_stopped: "You stopped the recording.",
  meeting_ended: "The meeting ended.",
  window_closed: "The meeting window closed.",
  device_lost: "The audio device stopped.",
  prolonged_inactivity: "No one spoke for a long time.",
  hard_limit: "The maximum length was reached.",
};

export function MeetingPanel({
  sources,
}: {
  sources: { id: string; name: string; kind: string }[];
}) {
  const [device, setDevice] = useState<PairInfo | null>(null);
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"audio" | "video">("audio");
  const [title, setTitle] = useState("Meeting notes");
  const [screen, setScreen] = useState("");
  const [watchWindow, setWatchWindow] = useState("");
  const [systemAudio, setSystemAudio] = useState(true);
  const [{ recording }, dispatch] = useReducer(lifecycle, initialLifecycle);
  const [warning, setWarning] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<NoteTakerLink | null>(null);
  const [devices, setDevices] = useState<AudioDevices | null>(null);
  const [microphone, setMicrophone] = useState("");

  const screens = sources.filter((s) => s.kind === "MONITOR");

  useEffect(() => {
    void meeting
      .device()
      .then(setDevice)
      .catch(() => {});
    void meeting
      .recording()
      .then((id) => id && dispatch({ type: "started", id }))
      .catch(() => {});
    void meeting
      .pendingLink()
      .then((l) => l && setLink(l))
      .catch(() => {});
    const offs = [
      listen<NoteTakerLink>("note-taker-request", (e) => setLink(e.payload)),
      listen<MeetingEvent>("meeting-event", (e) => {
        const ev = e.payload;
        if (ev.kind === "warning") {
          const mins = Math.max(1, Math.round(ev.stops_in_ms / 60000));
          setWarning(
            ev.reason === "inactivity"
              ? `No one has spoken for a while. Cap stops in about ${mins} min.`
              : ev.reason === "hard_limit"
                ? `Cap reaches its maximum length in about ${mins} min.`
                : `The meeting seems to have ended. Cap stops in about ${mins} min.`,
          );
        } else if (ev.kind === "stopped") {
          setWarning(null);
          dispatch({ type: "stopped", id: ev.meeting_id });
          setMessage(
            `${stopText[ev.reason] ?? "Recording stopped."} Uploading to Calari…`,
          );
        } else if (ev.kind === "finalized") {
          setMessage(
            "Sent to Calari. The transcript will appear in the client's portal.",
          );
        } else if (ev.kind === "failed") {
          setMessage(
            `Upload paused: ${ev.message}. Cap will retry the next time it opens.`,
          );
        }
      }),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()));
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }

  const start = (overrideMode?: "audio" | "video", overrideTitle?: string) =>
    run(async () => {
      const m = overrideMode ?? mode;
      await startFromForm(
        { start: meeting.start, dispatch },
        {
          title: overrideTitle || title,
          mode: m,
          microphoneId: microphone || undefined,
          systemAudio,
          videoSourceId: m === "video" ? screen || screens[0]?.id : undefined,
          watchWindow: watchWindow || undefined,
        },
      );
    });

  const acceptLink = () =>
    run(async () => {
      if (!link) return;
      const l = link;
      await startFromLink(
        {
          start: meeting.start,
          pair: meeting.pair,
          dispatch,
          onPaired: (info) => {
            setDevice(info);
            setLink(null);
            setMode(l.mode);
          },
        },
        l,
        {
          title: l.title || "Meeting notes",
          mode: l.mode,
          microphoneId: microphone || undefined,
          systemAudio,
          videoSourceId:
            l.mode === "video" ? screen || screens[0]?.id : undefined,
        },
      );
    });

  const who =
    device?.pairingKind === "internal_team"
      ? "an internal team meeting"
      : device?.clientName || "this client";

  return (
    <section className="card">
      <div className="card-header">
        <div className="card-title">Meeting notes for Calari</div>
      </div>

      {link && !recording && (
        <div className="banner">
          <div>
            <strong>Add note taker?</strong> Calari asked Cap to record a
            meeting ({link.mode === "video" ? "video" : "audio"} + transcript).
            Tell everyone in the meeting it is being recorded.
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void acceptLink()}
              >
                {busy ? "Starting…" : "Start recording"}
              </button>
              <button className="btn btn-ghost" onClick={() => setLink(null)}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

      {!device && !link && (
        <div style={{ display: "grid", gap: 8 }}>
          <p className="card-subtitle">
            Enter the pairing code from the Calari intake receipt or client
            page.
          </p>
          <input
            className="record-title-input"
            placeholder="XXXX-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-label="Pairing code"
          />
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              void run(async () => setDevice(await meeting.pair(code)))
            }
          >
            Connect
          </button>
        </div>
      )}

      {device && !recording && (
        <div style={{ display: "grid", gap: 8 }}>
          <p className="card-subtitle">Connected for {who}.</p>
          <input
            className="record-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Meeting title"
          />
          <label>
            <input
              type="radio"
              checked={mode === "audio"}
              onChange={() => setMode("audio")}
            />{" "}
            Audio + transcript (meeting notes)
          </label>
          <label>
            <input
              type="radio"
              checked={mode === "video"}
              onChange={() => setMode("video")}
            />{" "}
            Video + transcript
          </label>
          {mode === "video" && (
            <select
              value={screen}
              onChange={(e) => setScreen(e.target.value)}
              aria-label="Screen"
            >
              {screens.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          {devices && devices.microphones.length > 0 && (
            <select
              value={microphone}
              onChange={(e) => setMicrophone(e.target.value)}
              aria-label="Microphone"
            >
              {devices.microphones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          <label>
            <input
              type="checkbox"
              checked={systemAudio}
              disabled={devices !== null && !devices.systemAudioAvailable}
              onChange={(e) => setSystemAudio(e.target.checked)}
            />{" "}
            Include other people's audio (computer sound)
          </label>
          {devices && !devices.systemAudioAvailable && (
            <p className="card-subtitle">
              {devices.platform === "macos"
                ? "Recording the computer's sound is not available on this Mac yet, so only your microphone is recorded."
                : "Recording the computer's sound is not available here, so only your microphone is recorded."}
            </p>
          )}
          <input
            className="record-title-input"
            placeholder="Stop when this window closes, e.g. Zoom Meeting (optional)"
            value={watchWindow}
            onChange={(e) => setWatchWindow(e.target.value)}
            aria-label="Meeting window to watch"
          />
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void start()}
          >
            {busy ? "Starting…" : "Start recording"}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void meeting.unpair().then(() => setDevice(null))}
          >
            Disconnect
          </button>
        </div>
      )}

      {recording && (
        <div style={{ display: "grid", gap: 8 }}>
          <p className="card-subtitle">
            ● Recording for {who}. Cap stops by itself when the meeting ends or
            after a long silence, with a warning first.
          </p>
          {warning && (
            <div className="banner">
              {warning}
              <button
                className="btn btn-ghost"
                onClick={() => void meeting.keep().then(() => setWarning(null))}
              >
                Keep recording
              </button>
            </div>
          )}
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void run(() => meeting.stop())}
          >
            Stop and send to Calari
          </button>
        </div>
      )}

      {message && <p className="card-subtitle">{message}</p>}
    </section>
  );
}
