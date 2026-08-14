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

function recordingBitrate(track: MediaStreamTrack | undefined): number {
  const settings = track?.getSettings();
  const pixels = (settings?.width ?? 1_920) * (settings?.height ?? 1_080);
  // Screen text needs more detail than camera footage. Cap the browser's
  // otherwise unbounded default while retaining enough bitrate for 4K shares.
  if (pixels >= 3_840 * 2_160) return 10_000_000;
  if (pixels >= 2_560 * 1_440) return 7_000_000;
  if (pixels >= 1_920 * 1_080) return 5_000_000;
  return 3_000_000;
}

type RecordingQuality = "compatibility" | "balanced" | "ultra";

const qualityMultiplier: Record<RecordingQuality, number> = {
  compatibility: 0.65,
  balanced: 1,
  ultra: 1.4,
};

export function suggestedRecordingTitle(
  sourceLabel: string | undefined,
  now = new Date(),
): string {
  const source = sourceLabel
    ?.replace(/\s+-\s+.*$/u, "")
    .replace(/^(screen|window|tab)\s*[:#-]?\s*/iu, "")
    .trim();
  if (source && !/^\d+$/u.test(source)) return source.slice(0, 160);
  return `Recording ${now.toLocaleString()}`;
}

export function CaptureStudio() {
  const [state, setState] = useState<CaptureState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState("");
  const [includeMic, setIncludeMic] = useState(true);
  const [includeCamera, setIncludeCamera] = useState(false);
  const [recordingTitle, setRecordingTitle] = useState("");
  const [quality, setQuality] = useState<RecordingQuality>("balanced");
  const [online, setOnline] = useState(true);
  const [networkLabel, setNetworkLabel] = useState("Online");
  const [deviceCheck, setDeviceCheck] = useState<
    "unchecked" | "checking" | "ready" | "failed"
  >("unchecked");
  const [micLevel, setMicLevel] = useState(0);
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
  const cameraPreview = useRef<HTMLVideoElement | null>(null);
  const meterContext = useRef<AudioContext | undefined>(undefined);
  const meterFrame = useRef<number | undefined>(undefined);
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
    },
    [recordingUrl],
  );

  useEffect(
    () => () => {
      displayStream.current?.getTracks().forEach((track) => track.stop());
      micStream.current?.getTracks().forEach((track) => track.stop());
      cameraStream.current?.getTracks().forEach((track) => track.stop());
      if (meterFrame.current !== undefined)
        window.cancelAnimationFrame(meterFrame.current);
      void meterContext.current?.close().catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    const updateNetwork = () => {
      const isOnline = navigator.onLine;
      setOnline(isOnline);
      const connection = (
        navigator as Navigator & {
          connection?: { effectiveType?: string; downlink?: number };
        }
      ).connection;
      setNetworkLabel(
        !isOnline
          ? "Offline"
          : connection?.effectiveType
            ? `${connection.effectiveType.toUpperCase()}${connection.downlink ? ` · ${connection.downlink} Mbps` : ""}`
            : "Online",
      );
    };
    updateNetwork();
    window.addEventListener("online", updateNetwork);
    window.addEventListener("offline", updateNetwork);
    return () => {
      window.removeEventListener("online", updateNetwork);
      window.removeEventListener("offline", updateNetwork);
    };
  }, []);

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

  function stopMeter() {
    if (meterFrame.current !== undefined)
      window.cancelAnimationFrame(meterFrame.current);
    meterFrame.current = undefined;
    void meterContext.current?.close().catch(() => undefined);
    meterContext.current = undefined;
    setMicLevel(0);
  }

  function startMeter(stream: MediaStream | undefined) {
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    stopMeter();
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const measure = () => {
      analyser.getByteFrequencyData(samples);
      const average =
        samples.reduce((sum, value) => sum + value, 0) / samples.length;
      setMicLevel(Math.min(100, Math.round((average / 90) * 100)));
      meterFrame.current = window.requestAnimationFrame(measure);
    };
    meterContext.current = context;
    measure();
  }

  function clearDevicePreview() {
    stopMeter();
    micStream.current?.getTracks().forEach((track) => track.stop());
    cameraStream.current?.getTracks().forEach((track) => track.stop());
    micStream.current = undefined;
    cameraStream.current = undefined;
    if (cameraPreview.current) cameraPreview.current.srcObject = null;
    setDeviceCheck("unchecked");
  }

  async function checkDevices() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setDeviceCheck("failed");
      setMessage("This browser cannot test camera or microphone devices.");
      return;
    }
    if (!includeMic && !includeCamera) {
      setDeviceCheck("ready");
      setMessage("Screen capture is ready. No camera or microphone selected.");
      return;
    }
    clearDevicePreview();
    setDeviceCheck("checking");
    setMessage("Checking selected devices…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: includeMic,
        video: includeCamera,
      });
      micStream.current = stream.getAudioTracks().length
        ? new MediaStream(stream.getAudioTracks())
        : undefined;
      cameraStream.current = stream.getVideoTracks().length
        ? new MediaStream(stream.getVideoTracks())
        : undefined;
      if (cameraPreview.current)
        cameraPreview.current.srcObject = cameraStream.current ?? null;
      startMeter(micStream.current);
      setDeviceCheck("ready");
      setMessage("Selected devices are ready.");
    } catch {
      setDeviceCheck("failed");
      setMessage(
        "Camera or microphone access was denied. Check browser permissions.",
      );
    }
  }

  function stopTracks() {
    stopMeter();
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
      let microphone =
        includeMic &&
        micStream.current?.getAudioTracks()[0]?.readyState === "live"
          ? micStream.current
          : undefined;
      if (includeMic && !microphone)
        microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStream.current = microphone;
      let camera =
        includeCamera &&
        cameraStream.current?.getVideoTracks()[0]?.readyState === "live"
          ? cameraStream.current
          : undefined;
      if (includeCamera && !camera)
        camera = await navigator.mediaDevices.getUserMedia({ video: true });
      cameraStream.current = camera;
      stopMeter();
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
      const recorderOptions: MediaRecorderOptions = {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: Math.round(
          recordingBitrate(display.getVideoTracks()[0]) *
            qualityMultiplier[quality],
        ),
        audioBitsPerSecond: 128_000,
      };
      const nextRecorder = new MediaRecorder(combined, recorderOptions);
      recorder.current = nextRecorder;
      const title =
        recordingTitle.trim() ||
        suggestedRecordingTitle(display.getVideoTracks()[0]?.label);
      setRecordingTitle(title);
      const contentType = nextRecorder.mimeType
        .toLowerCase()
        .startsWith("video/mp4")
        ? "video/mp4"
        : "video/webm";
      const localScreenChunks: Blob[] = [];
      let liveUpload: StreamingUploadController | undefined;
      try {
        liveUpload = await beginStreamingUpload(title, contentType);
        streamingUpload.current = liveUpload;
        setRecordingId(liveUpload.recordingId);
      } catch {
        setRecordingId(undefined);
        setMessage(
          "Upload service unavailable. Recording locally until you reconnect.",
        );
      }
      setLiveRecordedBytes(0);
      setLiveUploadedBytes(0);
      nextRecorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        if (!liveUpload) {
          localScreenChunks.push(event.data);
          setLiveRecordedBytes((current) => current + event.data.size);
          return;
        }
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
      const localCameraChunks: Blob[] = [];
      if (camera) {
        nextCameraRecorder = new MediaRecorder(camera, {
          ...recorderOptions,
          videoBitsPerSecond: Math.min(
            quality === "ultra" ? 4_000_000 : 3_000_000,
            Math.round(
              recordingBitrate(camera.getVideoTracks()[0]) *
                qualityMultiplier[quality],
            ),
          ),
        });
        cameraRecorder.current = nextCameraRecorder;
        if (liveUpload) {
          liveCameraUpload = await beginStreamingUpload(
            `${title} (camera)`,
            contentType,
            liveUpload.recordingId,
          );
          cameraStreamingUpload.current = liveCameraUpload;
        }
        nextCameraRecorder.ondataavailable = (event) => {
          if (!event.data.size) return;
          if (!liveCameraUpload) {
            localCameraChunks.push(event.data);
            return;
          }
          void liveCameraUpload.append(event.data).catch(() => {
            setMessage(
              "Camera upload paused. Capture continues locally and will retry when you stop.",
            );
          });
        };
        nextCameraRecorder.onstop = () => {
          setCameraBlob(
            liveCameraUpload
              ? liveCameraUpload.snapshot().blob
              : new Blob(localCameraChunks, { type: contentType }),
          );
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
        if (!liveUpload) {
          const completedBlob = new Blob(localScreenChunks, {
            type: contentType,
          });
          setRecordingBlob(completedBlob);
          setRecordingUrl((previous) => {
            if (previous) URL.revokeObjectURL(previous);
            return URL.createObjectURL(completedBlob);
          });
          await cameraStopped;
          setState("ready");
          setMessage(
            "Recording saved locally. Reconnect, then upload securely.",
          );
          return;
        }
        setState("uploading");
        setMessage("Finishing the last upload part…");
        try {
          const screenFinish = liveUpload.finish((completed, total) => {
            setLiveUploadedBytes(completed);
            setLiveRecordedBytes(total);
            setUploadProgress(Math.round((completed / total) * 100));
          });
          const cameraFinish = liveCameraUpload
            ? cameraStopped.then(async () => {
                setMessage("Securing the final screen and camera chunks…");
                const cameraResult = await liveCameraUpload.finish();
                setCameraBlob(liveCameraUpload.snapshot().blob);
                return cameraResult;
              })
            : Promise.resolve(undefined);
          const [screenOutcome, cameraOutcome] = await Promise.allSettled([
            screenFinish,
            cameraFinish,
          ]);
          if (screenOutcome.status === "rejected") throw screenOutcome.reason;
          if (cameraOutcome.status === "rejected") throw cameraOutcome.reason;
          const result = screenOutcome.value;
          const completedBlob = liveUpload.snapshot().blob;
          setRecordingBlob(completedBlob);
          setRecordingUrl((previous) => {
            if (previous) URL.revokeObjectURL(previous);
            return URL.createObjectURL(completedBlob);
          });
          setRecordingId(result.recordingId);
          await cameraStopped;
          setUploadProgress(100);
          setState("ready");
          setMessage(
            "Upload complete. Playback is available while enhancements finish.",
          );
          await refreshPendingUploads();
          streamingUpload.current = undefined;
          cameraStreamingUpload.current = undefined;
        } catch (error) {
          const backup = liveUpload.snapshot().blob;
          if (backup.size) {
            setRecordingBlob(backup);
            setRecordingUrl((previous) => {
              if (previous) URL.revokeObjectURL(previous);
              return URL.createObjectURL(backup);
            });
          }
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
        !liveUpload
          ? "Recording locally. Upload when your connection is ready."
          : camera
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
      const title = recordingTitle.trim() || suggestedRecordingTitle(undefined);
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

  const bufferedBytes = Math.max(0, liveRecordedBytes - liveUploadedBytes);
  const liveUploadLabel = !recordingId
    ? "Saved locally"
    : liveUploadedBytes === 0
      ? "Buffering first part"
      : bufferedBytes <= 7 * 1024 * 1024
        ? "Upload live"
        : "Upload catching up";

  return (
    <section className="studio" aria-live="polite">
      <header className="studio-heading">
        <h1>New recording</h1>
        <span className={`studio-state studio-state-${state}`}>
          <span aria-hidden="true" />
          {captureStateLabel[state]}
        </span>
      </header>
      <div className="recording-setup">
        <label className="recording-title-input">
          <span>Title</span>
          <input
            value={recordingTitle}
            maxLength={160}
            placeholder="Added automatically if blank"
            disabled={state === "recording" || state === "requesting"}
            onChange={(event) => setRecordingTitle(event.target.value)}
          />
        </label>
        <label className="recording-quality-select">
          <span>Quality</span>
          <select
            value={quality}
            disabled={state === "recording" || state === "requesting"}
            onChange={(event) =>
              setQuality(event.target.value as RecordingQuality)
            }
          >
            <option value="compatibility">Compatibility</option>
            <option value="balanced">Balanced</option>
            <option value="ultra">Ultra</option>
          </select>
        </label>
        <div
          className={`network-health ${online ? "is-online" : "is-offline"}`}
        >
          <span aria-hidden="true" />
          <div>
            <small>Connection</small>
            <strong>{networkLabel}</strong>
          </div>
        </div>
      </div>
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
              onChange={(event) => {
                clearDevicePreview();
                setIncludeMic(event.target.checked);
              }}
            />
            <span>Microphone</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={includeCamera}
              disabled={state === "recording" || state === "requesting"}
              onChange={(event) => {
                clearDevicePreview();
                setIncludeCamera(event.target.checked);
              }}
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
      <div className="device-check-row">
        <button
          type="button"
          className="btn-secondary"
          disabled={
            deviceCheck === "checking" ||
            state === "recording" ||
            state === "requesting"
          }
          onClick={() => void checkDevices()}
        >
          {deviceCheck === "checking"
            ? "Checking…"
            : deviceCheck === "ready"
              ? "Devices ready"
              : "Check devices"}
        </button>
        {includeMic && (
          <div
            className="mic-meter"
            aria-label={`Microphone level ${micLevel}%`}
          >
            <span>Mic</span>
            <i>
              <b style={{ width: `${micLevel}%` }} />
            </i>
          </div>
        )}
        {includeCamera && (
          <video
            ref={cameraPreview}
            className="camera-check-preview"
            autoPlay
            muted
            playsInline
            aria-label="Camera preview"
          />
        )}
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
                {state === "recording" ? liveUploadLabel : "Finishing upload"}
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
                ? !recordingId
                  ? "Reconnect when ready; the full recording remains in this browser."
                  : "Captured media is saved locally before each network attempt."
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
