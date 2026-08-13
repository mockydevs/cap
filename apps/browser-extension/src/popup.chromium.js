// Chromium-only popup. Duplicates the ~15-line `normalize` pure function
// from popup.firefox.js instead of importing a shared module — deliberate,
// given this whole fork's goal is keeping the two popups fully independent
// so a shared-module refactor can never accidentally break Firefox.
import { ensureHostPermission, getToken, login, logout } from "./lib/auth.js";
import { signInWithGoogle } from "./lib/google-auth.js";
import { listPendingUploads, resumeUpload } from "./vendor/resumable-client.js";

const DEFAULT_SERVER = "http://localhost:3000";
const api = chrome;

export const normalize = (value) => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  )
    throw new Error("Use HTTPS (HTTP is allowed only for localhost)");
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Enter only the server origin, without a path or credentials",
    );
  return url.origin;
};

export async function currentServer() {
  const saved = await api.storage.sync.get({ serverUrl: DEFAULT_SERVER });
  return normalize(String(saved.serverUrl));
}

const serverInput = document.querySelector("#server");
const status = document.querySelector("#status");
const loginSection = document.querySelector("#login-section");
const recordingSection = document.querySelector("#recording-section");
const emailInput = document.querySelector("#email");
const passwordInput = document.querySelector("#password");
const loginStatus = document.querySelector("#login-status");
const signedInAs = document.querySelector("#signed-in-as");
const sourceSelect = document.querySelector("#source");
const includeMicInput = document.querySelector("#include-mic");
const includeCameraInput = document.querySelector("#include-camera");
const titleInput = document.querySelector("#title");
const pendingBanner = document.querySelector("#pending-upload-banner");

async function open(path) {
  await api.tabs.create({ url: `${await currentServer()}${path}` });
  window.close();
}

/** Re-renders the login-vs-recording section based on current auth state. */
export async function render() {
  const serverOrigin = await currentServer();
  const auth = await getToken(serverOrigin);
  if (auth) {
    loginSection.hidden = true;
    recordingSection.hidden = false;
    signedInAs.textContent = `Signed in as ${auth.email}`;
    if (!titleInput.value)
      titleInput.value = `Recording — ${new Date().toLocaleString()}`;
  } else {
    loginSection.hidden = false;
    recordingSection.hidden = true;
  }
  await renderPendingUploadBanner(serverOrigin);
}

/**
 * Shows the "resume pending upload" banner when IndexedDB holds any
 * unfinished PendingUpload records. PendingUpload records carry no server
 * origin of their own (they're scoped to whatever server was active when
 * the recording began), so this treats "any pending upload" as relevant to
 * the currently configured server — the only origin this popup can act on.
 * @param {string} serverOrigin
 */
export async function renderPendingUploadBanner(serverOrigin) {
  const auth = await getToken(serverOrigin);
  const pending = auth ? await listPendingUploads() : [];
  pendingBanner.hidden = pending.length === 0;
}

document
  .querySelector("#library")
  .addEventListener("click", () => void open("/library"));

document.querySelector("#save").addEventListener("click", async () => {
  try {
    const serverUrl = normalize(serverInput.value.trim());
    await api.storage.sync.set({ serverUrl });
    const granted = await ensureHostPermission(serverUrl);
    status.textContent = granted
      ? "Saved. Open Cap to sign in or record."
      : "Saved, but permission to reach this server was declined. Grant it to sign in or record.";
    await render();
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Invalid server URL";
  }
});

document.querySelector("#sign-in").addEventListener("click", async () => {
  loginStatus.textContent = "Signing in…";
  try {
    const serverOrigin = await currentServer();
    await login(serverOrigin, emailInput.value.trim(), passwordInput.value);
    loginStatus.textContent = "";
    passwordInput.value = "";
    await render();
  } catch (error) {
    loginStatus.textContent =
      error instanceof Error ? error.message : "Sign-in failed";
  }
});

document
  .querySelector("#sign-in-google")
  .addEventListener("click", async () => {
    loginStatus.textContent = "Opening Google sign-in…";
    try {
      const serverOrigin = await currentServer();
      await signInWithGoogle(serverOrigin);
      loginStatus.textContent = "";
      await render();
    } catch (error) {
      loginStatus.textContent =
        error instanceof Error ? error.message : "Google sign-in failed";
    }
  });

document.querySelector("#sign-out").addEventListener("click", async () => {
  const serverOrigin = await currentServer();
  await logout(serverOrigin);
  await render();
});

document
  .querySelector("#start-recording")
  .addEventListener("click", async () => {
    api.runtime.sendMessage({
      type: "POPUP_START_RECORDING",
      source: sourceSelect.value,
      includeMic: includeMicInput.checked,
      includeCamera: includeCameraInput.checked,
      title: titleInput.value.trim() || "Cap recording",
    });
    // Recording is orchestrated by background/offscreen/controls
    // independently of the popup staying open.
    window.close();
  });

document.querySelector("#resume-upload").addEventListener("click", async () => {
  const serverOrigin = await currentServer();
  const auth = await getToken(serverOrigin);
  if (!auth) return;
  const config = {
    baseUrl: serverOrigin,
    authorization: `Bearer ${auth.token}`,
  };
  const pending = await listPendingUploads();
  await Promise.all(
    pending.map((upload) => resumeUpload(upload, undefined, config)),
  );
  await renderPendingUploadBanner(serverOrigin);
});

void currentServer().then((value) => {
  serverInput.value = value;
});
void render();
