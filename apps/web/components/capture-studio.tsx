"use client";

import { type CaptureState, formatDuration, selectRecorderMimeType } from "@cap/recording";
import { useEffect, useRef, useState } from "react";

export function CaptureStudio() {
  const [state, setState] = useState<CaptureState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState("Choose a source when you are ready.");
  const [includeMic, setIncludeMic] = useState(true);
  const [recordingUrl, setRecordingUrl] = useState<string>();
  const recorder = useRef<MediaRecorder>();
  const displayStream = useRef<MediaStream>();
  const micStream = useRef<MediaStream>();
  const startedAt = useRef(0);

  useEffect(() => () => {
    recordingUrl && URL.revokeObjectURL(recordingUrl);
    stopTracks();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingUrl]);

  useEffect(() => {
    if (state !== "recording") return;
    const interval = window.setInterval(() => setElapsed(Date.now() - startedAt.current), 250);
    return () => window.clearInterval(interval);
  }, [state]);

  function stopTracks() {
    displayStream.current?.getTracks().forEach((track) => track.stop());
    micStream.current?.getTracks().forEach((track) => track.stop());
    displayStream.current = undefined;
    micStream.current = undefined;
  }

  async function start() {
    if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
      setState("error"); setMessage("This browser does not support screen capture. Try a current Chromium, Firefox, or Safari browser."); return;
    }
    setState("requesting"); setMessage("Waiting for your screen-sharing choice…");
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      displayStream.current = display;
      let microphone: MediaStream | undefined;
      if (includeMic) microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStream.current = microphone;
      const audio = new MediaStream([...display.getAudioTracks(), ...(microphone?.getAudioTracks() ?? [])]);
      const combined = new MediaStream([...display.getVideoTracks(), ...audio.getAudioTracks()]);
      const chunks: BlobPart[] = [];
      const mimeType = selectRecorderMimeType((value) => MediaRecorder.isTypeSupported(value));
      const nextRecorder = new MediaRecorder(combined, mimeType ? { mimeType } : undefined);
      recorder.current = nextRecorder;
      nextRecorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      nextRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: nextRecorder.mimeType || "video/webm" });
        setRecordingUrl((previous) => { previous && URL.revokeObjectURL(previous); return URL.createObjectURL(blob); });
        setState("ready"); setMessage("Recording ready. Preview it or download the WebM file."); stopTracks();
      };
      display.getVideoTracks()[0]?.addEventListener("ended", () => nextRecorder.state === "recording" && nextRecorder.stop());
      startedAt.current = Date.now(); setElapsed(0); nextRecorder.start(2_000); setState("recording"); setMessage("Recording locally in this browser.");
    } catch (error) {
      stopTracks(); setState("error"); setMessage(error instanceof DOMException && error.name === "NotAllowedError" ? "Screen or microphone access was denied." : "Could not start capture. Please try again.");
    }
  }

  function stop() { if (recorder.current?.state === "recording") { setState("stopping"); setMessage("Finishing your local recording…"); recorder.current.stop(); } }

  return <section className="studio" aria-live="polite">
    <div className="recording-panel">
      <div><p className="status">{state === "recording" ? "● Recording" : state.replace("ing", "")}</p><strong className="timer">{formatDuration(elapsed)}</strong></div>
      <label className="toggle"><input type="checkbox" checked={includeMic} disabled={state === "recording" || state === "requesting"} onChange={(event) => setIncludeMic(event.target.checked)} /> Include microphone</label>
      {state === "recording" || state === "stopping" ? <button className="stop" onClick={stop} disabled={state === "stopping"}>Stop recording</button> : <button onClick={start} disabled={state === "requesting"}>Start capture</button>}
    </div>
    <p className="hint">{message}</p>
    {recordingUrl && <div className="preview"><video controls src={recordingUrl} /><a href={recordingUrl} download="cap-recording.webm">Download recording</a></div>}
  </section>;
}
