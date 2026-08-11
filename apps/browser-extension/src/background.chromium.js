// Chromium-only background service worker. Keeps every context-menu/
// command/library-launcher behavior background.firefox.js already has
// (still used for the "open the web library" and fallback paths) and adds
// the real in-browser recording orchestration: resolving capture stream
// ids, driving the offscreen document and the controls window, and
// reacting to upload outcomes.

import { clearToken, getToken, login } from "./lib/auth.js";
import { signInWithGoogle } from "./lib/google-auth.js";

const DEFAULT_SERVER = "http://localhost:3000";
const api = chrome;

export async function server() {
  const value = await api.storage.sync.get({ serverUrl: DEFAULT_SERVER });
  return String(value.serverUrl).replace(/\/$/, "");
}

export async function open(path) {
  await api.tabs.create({ url: `${await server()}${path}` });
}

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({
      id: "cap-record",
      title: "Record with Cap",
      contexts: ["page"],
    });
    api.contextMenus.create({
      id: "cap-library",
      title: "Open Cap library",
      contexts: ["page"],
    });
  });
});
api.contextMenus.onClicked.addListener(
  (info) => void open(info.menuItemId === "cap-library" ? "/library" : "/"),
);
api.commands.onCommand.addListener((command) => {
  if (command === "start-recording") void open("/");
});

// --- Recording orchestration -------------------------------------------

/** Tracks the server origin a recording was started against, so an
 * OFFSCREEN_UPLOAD_AUTH_EXPIRED reaction knows whose token to clear. */
let activeServerOrigin;
/** The controls window's id, if one is currently open. */
let controlsWindowId;

/**
 * Resolves the tabCapture/desktopCapture stream id (if any) for a capture
 * request's source. Returns `null` for a user-canceled desktopCapture
 * picker, which callers must treat as a silent no-op, not an error.
 * @param {"tab" | "screen" | "window" | "camera-only"} source
 */
export async function resolveStreamId(source) {
  if (source === "camera-only") return undefined;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (source === "tab") {
    return api.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  }
  // "screen" | "window": chrome.desktopCapture is callback-based.
  return new Promise((resolve) => {
    api.desktopCapture.chooseDesktopMedia([source], tab, (streamId) => {
      resolve(streamId || null);
    });
  });
}

/** Ensures the offscreen document exists, creating it if needed. */
export async function ensureOffscreenDocument() {
  const hasDocument = await api.offscreen.hasDocument();
  if (!hasDocument) {
    await api.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DISPLAY_MEDIA", "USER_MEDIA"],
      justification:
        "Recording tab/screen video and microphone audio for a Cap recording",
    });
  }
}

/** Opens the camera-bubble/controls popup window and returns its window id. */
export async function openControlsWindow() {
  const created = await api.windows.create({
    url: "controls.html",
    type: "popup",
    width: 220,
    height: 260,
    focused: true,
  });
  controlsWindowId = created.id;
  return created.id;
}

/**
 * Handles POPUP_START_RECORDING: resolves auth + stream id, spins up the
 * offscreen document and (if needed) the controls window, and kicks off
 * capture. Never opens any UI itself beyond the controls window — the
 * popup is the only place with a user gesture, so a missing-auth condition
 * here is purely a defensive fallback (the popup should already have
 * blocked Start when unauthenticated).
 * @param {{source: string, includeMic: boolean, includeCamera: boolean, title: string}} request
 */
export async function handleStartRecording(request) {
  const { source, includeMic, includeCamera, title } = request;
  const serverOrigin = await server();
  const auth = await getToken(serverOrigin);
  if (!auth) {
    return { ok: false, error: "Sign in first" };
  }

  const streamId = await resolveStreamId(source);
  if (streamId === null) {
    // User canceled the native desktopCapture picker: silent no-op.
    return { ok: false, canceled: true };
  }

  await ensureOffscreenDocument();

  activeServerOrigin = serverOrigin;
  const authorization = `Bearer ${auth.token}`;

  api.runtime.sendMessage({
    type: "OFFSCREEN_BEGIN_CAPTURE",
    streamId,
    source,
    includeMic,
    baseUrl: serverOrigin,
    authorization,
    title,
  });

  if (includeCamera || source === "camera-only") {
    await openControlsWindow();
    api.runtime.sendMessage({
      type: "CONTROLS_INIT",
      // Only the screen/tab/window + camera-bubble combo drives its own
      // camera capture inside the controls window; a camera-only source is
      // already fully captured by offscreen.js, so the controls window is
      // opened purely for its Pause/Resume/Stop UI in that case.
      includeCamera: Boolean(includeCamera && source !== "camera-only"),
      title,
      baseUrl: serverOrigin,
      authorization,
    });
  }

  await api.action.setBadgeBackgroundColor({ color: "#e53e3e" });
  await api.action.setBadgeText({ text: "REC" });

  return { ok: true };
}

export function relayToOffscreen(type, extra) {
  api.runtime.sendMessage({ type, ...extra });
}

export async function relayToControls(type, extra) {
  if (controlsWindowId === undefined) return;
  api.runtime.sendMessage({ type, ...extra });
}

export async function handleUploadDone({ recordingId }) {
  await api.action.setBadgeText({ text: "" });
  await relayToControls("CONTROLS_RECORDING_LINKED", { recordingId });
  controlsWindowId = undefined;
}

export async function handleUploadAuthExpired() {
  if (activeServerOrigin) await clearToken(activeServerOrigin);
  await api.action.setBadgeText({ text: "!" });
  if (typeof api.notifications !== "undefined") {
    api.notifications.create({
      type: "basic",
      iconUrl: api.runtime.getURL("icon128.png"),
      title: "Cap: sign-in expired",
      message:
        "Your recording is saved locally. Reopen the Cap popup to sign in again and resume the upload.",
    });
  }
}

export async function handleUploadFailed(message) {
  await api.action.setBadgeText({ text: "" });
  if (typeof api.notifications !== "undefined") {
    api.notifications.create({
      type: "basic",
      iconUrl: api.runtime.getURL("icon128.png"),
      title: "Cap recording",
      message: message || "Recording failed.",
    });
  }
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case "POPUP_LOGIN":
      login(message.serverOrigin, message.email, message.password)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    case "POPUP_GOOGLE_LOGIN":
      signInWithGoogle(message.serverOrigin)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    case "POPUP_LOGOUT":
      clearToken(message.serverOrigin).then(() => sendResponse({ ok: true }));
      return true;
    case "POPUP_START_RECORDING":
      handleStartRecording(message).then((result) => sendResponse(result));
      return true;
    case "CONTROLS_PAUSE":
      relayToOffscreen("OFFSCREEN_PAUSE");
      break;
    case "CONTROLS_RESUME":
      relayToOffscreen("OFFSCREEN_RESUME");
      break;
    case "CONTROLS_STOP":
      relayToOffscreen("OFFSCREEN_STOP");
      break;
    case "OFFSCREEN_UPLOAD_DONE":
      void handleUploadDone(message);
      break;
    case "OFFSCREEN_UPLOAD_AUTH_EXPIRED":
      void handleUploadAuthExpired();
      break;
    case "OFFSCREEN_UPLOAD_FAILED":
      void handleUploadFailed(message.message);
      break;
    case "OFFSCREEN_ERROR":
      void handleUploadFailed(message.message);
      break;
  }
  return undefined;
});
