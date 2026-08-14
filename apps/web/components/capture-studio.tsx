"use client";

import {
  type CaptureState,
  formatDuration,
  selectRecorderMimeType,
} from "@cap/recording";
import { useEffect, useRef, useState } from "react";
import {
  abortResumableUpload,
  beginResumableUpload,
  beginStreamingUpload,
  declaredContentType,
  listPendingUploads,
  pendingUploadProgress,
  type PendingUpload,
  resumeUpload,
  type StreamingUploadController,
} from "../lib/uploads/resumable-client";

const captureStateLabel: Record<CaptureState, string> = {
  idle: "Ready",
  requesting: "Selecting",
  recording: "Recording",
  stopping: "Finishing",
  uploading: "Uploading",
  ready: "Recorded",
  error: "Needs attention",
};

/**
 * Explains an upload failure by what actually went wrong.
 *
 * Every failure used to read "Sign in and retry", so a storage
 * misconfiguration, a dropped connection or a CORS rejection all sent the
 * person off to re-authenticate while the real cause went unreported. The
 * recording is safe in browser storage in every case, which is the one part
 * that was always worth saying.
 */
export function uploadFailureMessage(error: unknown): string {
  const kept = "Your recording is still here — download a backup or retry.";
  // fetch() rejects with a TypeError when the request never completed at all:
  // no network, DNS failure, or a cross-origin rejection from the storage host.
  if (error instanceof TypeError)
    return `Upload failed: could not reach the upload service. Check your connection, then retry. ${kept}`;
  if (!(error instanceof Error)) return `Upload failed. ${kept}`;
  if (error.message === "UNAUTHENTICATED")
    return `Upload failed: your session expired. Sign in, then retry. ${kept}`;
  return `Upload failed: ${error.message}. ${kept}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

export function CaptureStudio() {
  const [state, setState] = useState<CaptureState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState("");
  const [includeMic, setIncludeMic] = useState(true);
  const [includeCamera, setIncludeCamera] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState<string>();
  const [recordingBlob, setRecordingBlob] = useState<Blob>();
  const [cameraBlob, setCameraBlob] = useState<Blob>();
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [liveRecordedBytes, setLiveRecordedBytes] = useState(0);
  const [liveUploadedBytes, setLiveUploadedBytes] = useState(0);
  const [recordingId, setRecordingId] = useState<string>();
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [activePendingId, setActivePendingId] = useState<string>();
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const cameraRecorder = useRef<MediaRecorder | undefined>(undefined);
  const displayStream = useRef<MediaStream | undefined>(undefined);
  const micStream = useRef<MediaStream | undefined>(undefined);
  const cameraStream = useRef<MediaStream | undefined>(undefined);
  const startedAt = useRef(0);
  const streamingUpload = useRef<StreamingUploadController | undefined>(
    undefined,
  );
  const cameraStreamingUpload = useRef<StreamingUploadController | undefined>(
    undefined,
  );

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

  useEffect(() => {
    void listPendingUploads()
      .then(setPendingUploads)
      .catch(() => undefined);
  }, []);

  async function refreshPendingUploads() {
    setPendingUploads(await listPendingUploads());
  }

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
      const nextRecorder = new MediaRecorder(combined, recorderOptions);
      recorder.current = nextRecorder;
      const title = `Recording ${new Date().toLocaleString()}`;
      const contentType = nextRecorder.mimeType
        .toLowerCase()
        .startsWith("video/mp4")
        ? "video/mp4"
        : "video/webm";
      const liveUpload = await beginStreamingUpload(title, contentType);
      streamingUpload.current = liveUpload;
      setRecordingId(liveUpload.recordingId);
      setLiveRecordedBytes(0);
      setLiveUploadedBytes(0);
      nextRecorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        void liveUpload
          .append(event.data)
          .then(({ recordedBytes, uploadedBytes }) => {
            setLiveRecordedBytes(recordedBytes);
            setLiveUploadedBytes(uploadedBytes);
          })
          .catch(() => {
            setMessage(
              "Upload paused. Recording continues safely in this browser and will retry when you stop.",
            );
          });
      };

      let nextCameraRecorder: MediaRecorder | undefined;
      let cameraStoppedResolve: (() => void) | undefined;
      const cameraStopped = new Promise<void>((resolve) => {
        cameraStoppedResolve = resolve;
      });
      let liveCameraUpload: StreamingUploadController | undefined;
      if (camera) {
        nextCameraRecorder = new MediaRecorder(camera, recorderOptions);
        cameraRecorder.current = nextCameraRecorder;
        liveCameraUpload = await beginStreamingUpload(
          `${title} (camera)`,
          contentType,
          liveUpload.recordingId,
        );
        cameraStreamingUpload.current = liveCameraUpload;
        nextCameraRecorder.ondataavailable = (event) => {
          if (event.data.size)
            void liveCameraUpload!.append(event.data).catch(() => {
              setMessage(
                "Camera upload paused. Capture continues locally and will retry when you stop.",
              );
            });
        };
        nextCameraRecorder.onstop = () => {
          setCameraBlob(liveCameraUpload!.snapshot().blob);
          cameraStoppedResolve?.();
        };
      } else {
        setCameraBlob(undefined);
        cameraStoppedResolve?.();
      }

      nextRecorder.onstop = async () => {
        setUploadProgress(undefined);
        if (nextCameraRecorder?.state === "recording")
          nextCameraRecorder.stop();
        stopTracks();
        setState("uploading");
        setMessage("Finishing the last upload part…");
        try {
          const result = await liveUpload.finish((completed, total) => {
            setLiveUploadedBytes(completed);
            setLiveRecordedBytes(total);
            setUploadProgress(Math.round((completed / total) * 100));
          });
          const completedBlob = liveUpload.snapshot().blob;
          setRecordingBlob(completedBlob);
          setRecordingUrl((previous) => {
            if (previous) URL.revokeObjectURL(previous);
            return URL.createObjectURL(completedBlob);
          });
          setRecordingId(result.recordingId);
          await cameraStopped;
          if (liveCameraUpload) {
            setMessage("Finishing camera upload…");
            await liveCameraUpload.finish();
            setCameraBlob(liveCameraUpload.snapshot().blob);
          }
          setUploadProgress(100);
          setState("ready");
          setMessage(
            "Upload complete. Playback is available while enhancements finish.",
          );
          await refreshPendingUploads();
          streamingUpload.current = undefined;
          cameraStreamingUpload.current = undefined;
        } catch (error) {
          await refreshPendingUploads().catch(() => undefined);
          setState("error");
          setMessage(uploadFailureMessage(error));
        }
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
          ? "Recording and uploading your screen and camera."
          : "Recording and uploading as you go.",
      );
    } catch (error) {
      if (streamingUpload.current)
        await abortResumableUpload(streamingUpload.current.snapshot()).catch(
          () => undefined,
        );
      if (cameraStreamingUpload.current)
        await abortResumableUpload(
          cameraStreamingUpload.current.snapshot(),
        ).catch(() => undefined);
      streamingUpload.current = undefined;
      cameraStreamingUpload.current = undefined;
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
      await refreshPendingUploads();
      const result = await resumeUpload(
        pending,
        (completedBytes, totalBytes) => {
          setUploadProgress(
            totalBytes === 0
              ? 0
              : Math.round((completedBytes / totalBytes) * 100),
          );
        },
      );
      setUploadProgress(100);
      await refreshPendingUploads();
      setRecordingId(result.recordingId);
      if (cameraBlob) {
        setMessage("Uploading camera recording…");
        setUploadProgress(0);
        const pendingCamera = await beginResumableUpload(
          `${title} (camera)`,
          cameraBlob,
          result.recordingId,
        );
        await refreshPendingUploads();
        await resumeUpload(pendingCamera, (completedBytes, totalBytes) => {
          setUploadProgress(
            totalBytes === 0
              ? 0
              : Math.round((completedBytes / totalBytes) * 100),
          );
        });
        setUploadProgress(100);
        await refreshPendingUploads();
      }
      setState("ready");
      setMessage("Upload complete. Media processing has started.");
    } catch (error) {
      await refreshPendingUploads().catch(() => undefined);
      setState("error");
      setMessage(uploadFailureMessage(error));
    }
  }

  async function resumePending(pending: PendingUpload) {
    setActivePendingId(pending.sessionId);
    setState("uploading");
    setMessage("Resuming your interrupted upload…");
    setUploadProgress(pendingUploadProgress(pending).percent);
    try {
      const result = await resumeUpload(
        pending,
        (completedBytes, totalBytes) => {
          setUploadProgress(
            totalBytes === 0
              ? 0
              : Math.round((completedBytes / totalBytes) * 100),
          );
        },
      );
      setUploadProgress(100);
      setRecordingId(result.recordingId);
      setState("ready");
      setMessage("Upload complete. Media processing has started.");
      await refreshPendingUploads();
    } catch (error) {
      setState("error");
      setMessage(uploadFailureMessage(error));
      await refreshPendingUploads().catch(() => undefined);
    } finally {
      setActivePendingId(undefined);
    }
  }

  async function cancelPending(pending: PendingUpload) {
    setActivePendingId(pending.sessionId);
    setMessage("Canceling the interrupted upload…");
    try {
      await abortResumableUpload(pending);
      await refreshPendingUploads();
      setState("idle");
      setUploadProgress(undefined);
      setMessage("Interrupted upload canceled.");
    } catch (error) {
      setState("error");
      setMessage(uploadFailureMessage(error));
    } finally {
      setActivePendingId(undefined);
    }
  }

  return (
    <section className="studio" aria-live="polite">
      <header className="studio-heading">
        <h1>New recording</h1>
        <span className={`studio-state studio-state-${state}`}>
          <span aria-hidden="true" />
          {captureStateLabel[state]}
        </span>
      </header>
      <div className="recording-panel">
        <div className="timer-block">
          <strong className="timer">{formatDuration(elapsed)}</strong>
        </div>
        <div className="capture-options">
          <label className="toggle">
            <input
              type="checkbox"
              checked={includeMic}
              disabled={state === "recording" || state === "requesting"}
              onChange={(event) => setIncludeMic(event.target.checked)}
            />
            <span>Microphone</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={includeCamera}
              disabled={state === "recording" || state === "requesting"}
              onChange={(event) => setIncludeCamera(event.target.checked)}
            />
            <span>Camera</span>
          </label>
        </div>
        <div className="capture-primary-action">
          {state === "recording" || state === "stopping" ? (
            <button
              className="stop"
              onClick={stop}
              disabled={state === "stopping"}
            >
              <span aria-hidden="true" className="stop-icon" />
              Stop recording
            </button>
          ) : (
            <button onClick={start} disabled={state === "requesting"}>
              <span aria-hidden="true" className="capture-icon" />
              {state === "requesting" ? "Choose a screen…" : "Start capture"}
            </button>
          )}
        </div>
      </div>
      {message && (
        <p className="hint">
          <span aria-hidden="true" />
          {message}
        </p>
      )}
      {(state === "recording" || state === "uploading") &&
        liveRecordedBytes > 0 && (
          <div className="studio-upload-progress">
            <div className="upload-progress-copy">
              <strong>
                {state === "recording" ? "Uploading live" : "Finishing upload"}
              </strong>
              <span>
                {formatBytes(liveUploadedBytes)} of{" "}
                {formatBytes(liveRecordedBytes)}
              </span>
            </div>
            <div
              className="upload-progress-track"
              role="progressbar"
              aria-label="Recording upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                liveRecordedBytes === 0
                  ? 0
                  : Math.round((liveUploadedBytes / liveRecordedBytes) * 100)
              }
            >
              <span
                style={{
                  width: `${
                    liveRecordedBytes === 0
                      ? 0
                      : Math.round(
                          (liveUploadedBytes / liveRecordedBytes) * 100,
                        )
                  }%`,
                }}
              />
            </div>
            <small>
              {state === "recording"
                ? "Captured media is saved locally before each network attempt."
                : "Keep this tab open while the final part is secured."}
            </small>
          </div>
        )}
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
            <a
              href={recordingUrl}
              download={`cap-recording.${recordingBlob && declaredContentType(recordingBlob) === "video/mp4" ? "mp4" : "webm"}`}
            >
              Download backup
            </a>
          </div>
        </div>
      )}
      {pendingUploads.length > 0 && (
        <section
          className="pending-upload-list"
          aria-labelledby="pending-title"
        >
          <div className="pending-upload-heading">
            <div>
              <p className="eyebrow">Recovery</p>
              <h2 id="pending-title">Interrupted uploads</h2>
            </div>
            <span>{pendingUploads.length}</span>
          </div>
          {pendingUploads.map((pending) => {
            const progress = pendingUploadProgress(pending);
            const busy = activePendingId === pending.sessionId;
            return (
              <article className="pending-upload" key={pending.sessionId}>
                <div className="pending-upload-copy">
                  <strong>Screen recording</strong>
                  <span>
                    {formatBytes(progress.completedBytes)} of{" "}
                    {formatBytes(progress.totalBytes)} uploaded
                  </span>
                </div>
                <div
                  className="upload-progress-track"
                  role="progressbar"
                  aria-label="Interrupted upload progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress.percent}
                >
                  <span style={{ width: `${progress.percent}%` }} />
                </div>
                <strong className="pending-upload-percent">
                  {progress.percent}%
                </strong>
                <div className="pending-upload-actions">
                  <button
                    type="button"
                    disabled={Boolean(activePendingId)}
                    onClick={() => void resumePending(pending)}
                  >
                    {busy ? "Resuming…" : "Resume"}
                  </button>
                  <button
                    className="pending-upload-cancel"
                    type="button"
                    disabled={Boolean(activePendingId)}
                    onClick={() => void cancelPending(pending)}
                  >
                    Cancel
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </section>
  );
}
