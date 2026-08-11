// Chromium-only offscreen document. Runs the primary (screen/tab/window or
// camera-only) MediaRecorder capture and its upload, driven entirely by
// messages from background.chromium.js. Kept as small named, exported
// functions rather than one giant closure so each piece is unit-testable.
//
// Mirrors apps/web/components/capture-studio.tsx's codec-selection and
// track-combining approach: no manual AudioContext graph, just
// `new MediaStream([...tracks])`.

import { selectRecorderMimeType } from "./vendor/recording.js";
import { beginResumableUpload, resumeUpload } from "./vendor/resumable-client.js";

/** @type {MediaRecorder | undefined} */
let recorder;
/** @type {MediaStream | undefined} */
let activeStream;
/** @type {BlobPart[]} */
let chunks = [];
/**
 * Upload destination/title captured at OFFSCREEN_BEGIN_CAPTURE time, since
 * OFFSCREEN_STOP itself carries no fields — background already told us
 * everything it knows up front.
 * @type {{baseUrl?: string, authorization?: string, title?: string}}
 */
let captureConfig = {};

/**
 * Chrome's legacy `chromeMediaSource` constraint value differs by capture
 * origin even though both tabCapture and desktopCapture stream ids are
 * redeemed through this same getUserMedia constraint shape: tab capture
 * ids use "tab", desktopCapture (screen/window) ids use "desktop".
 * @param {"tab" | "screen" | "window" | "camera-only"} source
 */
export function chromeMediaSourceFor(source) {
  return source === "tab" ? "tab" : "desktop";
}

/**
 * Redeems a tabCapture/desktopCapture stream id into a live MediaStream.
 * @param {"tab" | "screen" | "window"} source
 * @param {string} streamId
 */
export async function redeemDisplayStream(source, streamId) {
  const chromeMediaSource = chromeMediaSourceFor(source);
  return navigator.mediaDevices.getUserMedia({
    video: { mandatory: { chromeMediaSource, chromeMediaSourceId: streamId } },
    audio: streamId
      ? { mandatory: { chromeMediaSource, chromeMediaSourceId: streamId } }
      : false,
  });
}

/**
 * Combines a display stream's tracks with an optional microphone stream's
 * audio tracks into a single MediaStream for the recorder, the same
 * simple track-combining approach capture-studio.tsx uses.
 * @param {MediaStream} display
 * @param {MediaStream | undefined} mic
 */
export function combineStreams(display, mic) {
  return new MediaStream([
    ...display.getVideoTracks(),
    ...display.getAudioTracks(),
    ...(mic?.getAudioTracks() ?? []),
  ]);
}

/**
 * Acquires the MediaStream to record for the given capture request.
 * @param {{source: string, streamId?: string, includeMic: boolean}} request
 */
export async function acquireStream({ source, streamId, includeMic }) {
  if (source === "camera-only") {
    return navigator.mediaDevices.getUserMedia({
      video: true,
      audio: includeMic,
    });
  }
  const display = await redeemDisplayStream(source, streamId);
  if (!includeMic) return display;
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  return combineStreams(display, mic);
}

/** Picks the best supported recorder codec, mirroring capture-studio.tsx. */
export function pickMimeType() {
  return selectRecorderMimeType((value) => MediaRecorder.isTypeSupported(value));
}

/**
 * Starts a MediaRecorder on `stream` at a 2000ms timeslice, matching
 * capture-studio.tsx, accumulating chunks into the module-level `chunks`.
 * @param {MediaStream} stream
 */
export function startRecording(stream) {
  chunks = [];
  const mimeType = pickMimeType();
  const nextRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  nextRecorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  nextRecorder.start(2000);
  return nextRecorder;
}

function stopTracks(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Handles OFFSCREEN_BEGIN_CAPTURE: acquires the stream, starts the
 * recorder, and replies OFFSCREEN_CAPTURE_STARTED or OFFSCREEN_ERROR.
 * @param {{source: string, streamId?: string, includeMic: boolean}} request
 */
export async function beginCapture(request) {
  captureConfig = {
    baseUrl: request.baseUrl,
    authorization: request.authorization,
    title: request.title,
  };
  try {
    const stream = await acquireStream(request);
    activeStream = stream;
    recorder = startRecording(stream);
    chrome.runtime.sendMessage({ type: "OFFSCREEN_CAPTURE_STARTED" });
  } catch (error) {
    chrome.runtime.sendMessage({
      type: "OFFSCREEN_ERROR",
      message: error instanceof Error ? error.message : "Could not start capture",
    });
  }
}

export function pauseCapture() {
  if (recorder?.state === "recording") recorder.pause();
}

export function resumeCapture() {
  if (recorder?.state === "paused") recorder.resume();
}

/**
 * Handles OFFSCREEN_STOP: stops the recorder, releases capture tracks (so
 * Chrome's capture indicator clears), assembles the Blob, and uploads it,
 * replying with the outcome.
 * @param {{baseUrl?: string, authorization?: string, title?: string}} [overrides]
 */
export async function stopCapture(overrides = {}) {
  if (!recorder) return;
  const { baseUrl, authorization, title } = { ...captureConfig, ...overrides };
  const finishedRecorder = recorder;
  const stream = activeStream;
  await new Promise((resolve) => {
    finishedRecorder.addEventListener("stop", () => resolve(undefined), {
      once: true,
    });
    finishedRecorder.stop();
  });
  stopTracks(stream);
  recorder = undefined;
  activeStream = undefined;

  const blob = new Blob(chunks, { type: finishedRecorder.mimeType || "video/webm" });
  chunks = [];
  const config = { baseUrl, authorization };
  try {
    const pending = await beginResumableUpload(title, blob, undefined, config);
    const result = await resumeUpload(pending, undefined, config);
    chrome.runtime.sendMessage({
      type: "OFFSCREEN_UPLOAD_DONE",
      recordingId: result.recordingId,
    });
  } catch (error) {
    // This app has no refresh/expiry mechanism: any failure once the upload
    // session has begun is treated as auth-suspect only when it looks like
    // an auth failure; otherwise it's a generic upload failure. There is no
    // structured error code plumbed through fetch failures here beyond the
    // message, so match conservatively on likely auth-failure wording.
    const message = error instanceof Error ? error.message : "Upload failed";
    if (/unauthorized|401|auth/i.test(message)) {
      chrome.runtime.sendMessage({ type: "OFFSCREEN_UPLOAD_AUTH_EXPIRED" });
    } else {
      chrome.runtime.sendMessage({ type: "OFFSCREEN_UPLOAD_FAILED", message });
    }
  }
}

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case "OFFSCREEN_BEGIN_CAPTURE":
      void beginCapture(message);
      break;
    case "OFFSCREEN_PAUSE":
      pauseCapture();
      break;
    case "OFFSCREEN_RESUME":
      resumeCapture();
      break;
    case "OFFSCREEN_STOP":
      void stopCapture(message);
      break;
  }
});
