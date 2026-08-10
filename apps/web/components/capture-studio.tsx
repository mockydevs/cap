"use client";

import {
  type CaptureState,
  formatDuration,
  selectRecorderMimeType,
} from "@cap/recording";
import { useEffect, useRef, useState } from "react";
import {
  beginResumableUpload,
  resumeUpload,
} from "../lib/uploads/resumable-client";

export function CaptureStudio() {
  const [state, setState] = useState<CaptureState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState("Choose a source when you are ready.");
  const [includeMic, setIncludeMic] = useState(true);
  const [includeCamera, setIncludeCamera] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState<string>();
  const [recordingBlob, setRecordingBlob] = useState<Blob>();
  const [cameraBlob, setCameraBlob] = useState<Blob>();
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [recordingId, setRecordingId] = useState<string>();
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const cameraRecorder = useRef<MediaRecorder | undefined>(undefined);
  const displayStream = useRef<MediaStream | undefined>(undefined);
  const micStream = useRef<MediaStream | undefined>(undefined);
  const cameraStream = useRef<MediaStream | undefined>(undefined);
  const startedAt = useRef(0);

  useEffect(
    () => () => {
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
      stopTracks();
    },
    [recordingUrl],
  );

  useEffect(() => {
    if (state !== "recording") return;
    const interval = window.setInterval(
      () => setElapsed(Date.now() - startedAt.current),
      250,
    );
    return () => window.clearInterval(interval);
  }, [state]);

  function stopTracks() {
    displayStream.current?.getTracks().forEach((track) => track.stop());
    micStream.current?.getTracks().forEach((track) => track.stop());
    cameraStream.current?.getTracks().forEach((track) => track.stop());
    displayStream.current = undefined;
    micStream.current = undefined;
    cameraStream.current = undefined;
  }

  async function start() {
    if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
      setState("error");
      setMessage(
        "This browser does not support screen capture. Try a current Chromium, Firefox, or Safari browser.",
      );
      return;
    }
    setState("requesting");
    setMessage("Waiting for your screen-sharing choice…");
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      displayStream.current = display;
      let microphone: MediaStream | undefined;
      if (includeMic)
        microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStream.current = microphone;
      let camera: MediaStream | undefined;
      if (includeCamera)
        camera = await navigator.mediaDevices.getUserMedia({ video: true });
      cameraStream.current = camera;
      const audio = new MediaStream([
        ...display.getAudioTracks(),
        ...(microphone?.getAudioTracks() ?? []),
      ]);
      const combined = new MediaStream([
        ...display.getVideoTracks(),
        ...audio.getAudioTracks(),
      ]);
      const mimeType = selectRecorderMimeType((value) =>
        MediaRecorder.isTypeSupported(value),
      );
      const recorderOptions = mimeType ? { mimeType } : undefined;
      const chunks: BlobPart[] = [];
      const nextRecorder = new MediaRecorder(combined, recorderOptions);
      recorder.current = nextRecorder;
      nextRecorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };

      const cameraChunks: BlobPart[] = [];
      let nextCameraRecorder: MediaRecorder | undefined;
      if (camera) {
        nextCameraRecorder = new MediaRecorder(camera, recorderOptions);
        cameraRecorder.current = nextCameraRecorder;
        nextCameraRecorder.ondataavailable = (event) => {
          if (event.data.size) cameraChunks.push(event.data);
        };
        nextCameraRecorder.onstop = () => {
          setCameraBlob(
            new Blob(cameraChunks, {
              type: nextCameraRecorder!.mimeType || "video/webm",
            }),
          );
        };
      } else {
        setCameraBlob(undefined);
      }

      nextRecorder.onstop = () => {
        const blob = new Blob(chunks, {
          type: nextRecorder.mimeType || "video/webm",
        });
        setRecordingBlob(blob);
        setRecordingId(undefined);
        setUploadProgress(undefined);
        setRecordingUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return URL.createObjectURL(blob);
        });
        if (nextCameraRecorder?.state === "recording")
          nextCameraRecorder.stop();
        setState("ready");
        setMessage("Recording ready. Preview it or download the WebM file.");
        stopTracks();
      };
      display.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (nextRecorder.state === "recording") nextRecorder.stop();
      });
      startedAt.current = Date.now();
      setElapsed(0);
      nextCameraRecorder?.start(2_000);
      nextRecorder.start(2_000);
      setState("recording");
      setMessage(
        camera
          ? "Recording your screen and camera locally in this browser."
          : "Recording locally in this browser.",
      );
    } catch (error) {
      stopTracks();
      setState("error");
      setMessage(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Screen or microphone access was denied."
          : "Could not start capture. Please try again.",
      );
    }
  }

  function stop() {
    if (recorder.current?.state === "recording") {
      setState("stopping");
      setMessage("Finishing your local recording…");
      recorder.current.stop();
    }
  }

  async function upload() {
    if (!recordingBlob) return;
    setState("uploading");
    setMessage("Securing your recording in private storage…");
    try {
      const title = `Recording ${new Date().toLocaleString()}`;
      const pending = await beginResumableUpload(title, recordingBlob);
      const result = await resumeUpload(pending, (completed, total) => {
        setUploadProgress(Math.round((completed / total) * 100));
      });
      setRecordingId(result.recordingId);
      if (cameraBlob) {
        setMessage("Uploading camera recording…");
        const pendingCamera = await beginResumableUpload(
          `${title} (camera)`,
          cameraBlob,
          result.recordingId,
        );
        await resumeUpload(pendingCamera, () => {});
      }
      setState("ready");
      setMessage("Upload complete. Media processing has started.");
    } catch (error) {
      setState("error");
      setMessage(
        error instanceof Error
          ? `Upload failed: ${error.message}. Sign in and retry; your recording remains in this browser.`
          : "Upload failed. Sign in and retry; your recording remains in this browser.",
      );
    }
  }

  return (
    <section className="studio" aria-live="polite">
      <div className="recording-panel">
        <div>
          <p className="status">
            {state === "recording" ? "● Recording" : state.replace("ing", "")}
          </p>
          <strong className="timer">{formatDuration(elapsed)}</strong>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={includeMic}
            disabled={state === "recording" || state === "requesting"}
            onChange={(event) => setIncludeMic(event.target.checked)}
          />{" "}
          Include microphone
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={includeCamera}
            disabled={state === "recording" || state === "requesting"}
            onChange={(event) => setIncludeCamera(event.target.checked)}
          />{" "}
          Include camera
        </label>
        {state === "recording" || state === "stopping" ? (
          <button
            className="stop"
            onClick={stop}
            disabled={state === "stopping"}
          >
            Stop recording
          </button>
        ) : (
          <button onClick={start} disabled={state === "requesting"}>
            Start capture
          </button>
        )}
      </div>
      <p className="hint">{message}</p>
      {recordingUrl && (
        <div className="preview">
          <video controls src={recordingUrl} />
          <div className="preview-actions">
            <button
              onClick={upload}
              disabled={state === "uploading" || Boolean(recordingId)}
            >
              {recordingId
                ? "Processing started"
                : state === "uploading"
                  ? `Uploading ${uploadProgress ?? 0}%`
                  : "Upload securely"}
            </button>
            <a href={recordingUrl} download="cap-recording.webm">
              Download backup
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
