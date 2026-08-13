// Chromium-only camera bubble + recording controls window, opened by
// background.chromium.js via chrome.windows.create({type:"popup", ...}).
//
// Note: chrome.windows.create popup windows have no confirmed OS-level
// "always on top" guarantee in MV3 — a known, documented limitation, not a
// bug to chase here.

import {
  beginResumableUpload,
  resumeUpload,
} from "./vendor/resumable-client.js";

const preview = document.querySelector("#camera-preview");
const statusEl = document.querySelector("#controls-status");
const pauseButton = document.querySelector("#pause");
const resumeButton = document.querySelector("#resume");
const stopButton = document.querySelector("#stop");

/** @type {MediaStream | undefined} */
let cameraStream;
/** @type {MediaRecorder | undefined} */
let cameraRecorder;
/** @type {BlobPart[]} */
let cameraChunks = [];
let includeCamera = false;
let title = "";
let baseUrl;
let authorization;
let stopping = false;

/** Starts the (sole) camera capture + its own MediaRecorder for the bubble. */
export async function startCameraCapture() {
  cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
  if (preview) {
    preview.hidden = false;
    preview.srcObject = cameraStream;
  }
  cameraChunks = [];
  cameraRecorder = new MediaRecorder(cameraStream);
  cameraRecorder.ondataavailable = (event) => {
    if (event.data.size) cameraChunks.push(event.data);
  };
  cameraRecorder.start(2000);
  return cameraRecorder;
}

function stopCameraTracks() {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = undefined;
}

/**
 * Initializes the controls window for a given capture request.
 * @param {{includeCamera: boolean, title: string, baseUrl?: string, authorization?: string}} init
 */
export async function init(init) {
  includeCamera = Boolean(init.includeCamera);
  title = init.title;
  baseUrl = init.baseUrl;
  authorization = init.authorization;
  if (includeCamera) await startCameraCapture();
}

export function pause() {
  chrome.runtime.sendMessage({ type: "CONTROLS_PAUSE" });
  if (cameraRecorder?.state === "recording") cameraRecorder.pause();
  if (pauseButton) pauseButton.hidden = true;
  if (resumeButton) resumeButton.hidden = false;
  if (statusEl) statusEl.textContent = "Paused";
}

export function resume() {
  chrome.runtime.sendMessage({ type: "CONTROLS_RESUME" });
  if (cameraRecorder?.state === "paused") cameraRecorder.resume();
  if (pauseButton) pauseButton.hidden = false;
  if (resumeButton) resumeButton.hidden = true;
  if (statusEl) statusEl.textContent = "Recording…";
}

/** Sends the stop request to background; the actual finish happens once
 * CONTROLS_RECORDING_LINKED (or, for no-camera, background's own stop
 * confirmation) arrives. */
export function requestStop() {
  if (stopping) return;
  stopping = true;
  if (statusEl) statusEl.textContent = "Finishing…";
  chrome.runtime.sendMessage({ type: "CONTROLS_STOP" });
  if (!includeCamera) {
    // Nothing of our own to upload; just wait for background's own
    // confirmation that the primary recording finished before closing.
  }
}

/**
 * Called once background relays that the primary (screen/tab/window)
 * recording finished and its recordingId is known. Stops the camera
 * recorder, uploads the linked camera Blob, and closes this window.
 * @param {{recordingId: string}} message
 */
export async function onRecordingLinked({ recordingId }) {
  if (!includeCamera || !cameraRecorder) {
    await closeSelf();
    return;
  }
  const finishedRecorder = cameraRecorder;
  await new Promise((resolve) => {
    finishedRecorder.addEventListener("stop", () => resolve(undefined), {
      once: true,
    });
    if (finishedRecorder.state !== "inactive") finishedRecorder.stop();
    else resolve(undefined);
  });
  stopCameraTracks();
  const blob = new Blob(cameraChunks, {
    type: finishedRecorder.mimeType || "video/webm",
  });
  cameraChunks = [];
  try {
    const pending = await beginResumableUpload(
      `${title} (camera)`,
      blob,
      recordingId,
      { baseUrl, authorization },
    );
    await resumeUpload(pending, undefined, { baseUrl, authorization });
  } catch {
    // The primary recording already succeeded; a failed camera upload is
    // surfaced by background separately and must not block window close.
  }
  await closeSelf();
}

export async function closeSelf() {
  stopCameraTracks();
  const current = await chrome.windows.getCurrent();
  if (current.id !== undefined) await chrome.windows.remove(current.id);
}

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case "CONTROLS_INIT":
      void init(message);
      break;
    case "CONTROLS_RECORDING_LINKED":
      void onRecordingLinked(message);
      break;
  }
});

pauseButton?.addEventListener("click", pause);
resumeButton?.addEventListener("click", resume);
stopButton?.addEventListener("click", requestStop);
