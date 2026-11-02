// Small helpers shared by the service worker, offscreen recorder and pages.
// Chrome only runs extension code as JavaScript; decision logic that does not
// need a browser API lives in Rust (detector.wasm).

export const CHUNK_MS = 30_000;
export const MEETING_HOSTS = [
  "meet.google.com",
  "zoom.us",
  "teams.microsoft.com",
  "teams.live.com",
  "webex.com",
  "whereby.com",
];

export function isMeetingUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      MEETING_HOSTS.some(
        (h) => u.hostname === h || u.hostname.endsWith(`.${h}`),
      )
    );
  } catch {
    return false;
  }
}

// IndexedDB is shared by all extension contexts of one origin, so chunks
// written by the offscreen recorder survive a crash and are re-sent later.
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("cap", 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore("chunks", { keyPath: ["meetingId", "seq"] });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("chunks", mode);
    const result = fn(t.objectStore("chunks"));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export const putChunk = (c) => tx("readwrite", (s) => s.put(c));
export const deleteChunk = (meetingId, seq) =>
  tx("readwrite", (s) => s.delete([meetingId, seq]));
export const pendingChunks = async (meetingId) => {
  const all = await tx("readonly", (s) => s.getAll());
  return all
    .filter((c) => !meetingId || c.meetingId === meetingId)
    .sort((a, b) => a.seq - b.seq);
};

export async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class ApiError extends Error {
  constructor(status, body) {
    super(
      `Cap server returned ${status}${body?.error ? ` (${body.error})` : ""}`,
    );
    this.status = status;
    this.body = body;
  }
}

export async function api(
  server,
  token,
  path,
  { method = "GET", json, body, headers = {} } = {},
) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (json !== undefined) h["content-type"] = "application/json";
  const res = await fetch(`${server}${path}`, {
    method,
    headers: h,
    body: json !== undefined ? JSON.stringify(json) : body,
    redirect: "error",
    credentials: "omit",
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed;
}

// What the device should do with its copy of a chunk after an upload try.
export function classifyUpload(status, body) {
  if (status === 200 || status === 201) return "ack";
  // Expired or replaced credential: keep the audio until the user pairs again.
  if (status === 401 || status === 404) return "reauth";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  // The server will never take these bytes for this slot. Keep them anyway.
  return "quarantine";
}

/// Uploads one stored chunk: "ack" | "retry" | "reauth" | "quarantine".
/// Only "ack" means the server has it; nothing else may delete local audio.
export async function uploadChunk(server, token, c) {
  try {
    await api(server, token, `/v1/meetings/${c.meetingId}/chunks/${c.seq}`, {
      method: "PUT",
      body: c.blob,
      headers: {
        "content-type": c.blob.type || "application/octet-stream",
        "x-chunk-sha256": c.sha256,
        "x-chunk-start-ms": String(c.startMs),
        "x-chunk-duration-ms": String(Math.max(1, c.durationMs)),
      },
    });
    return "ack";
  } catch (e) {
    return e instanceof ApiError ? classifyUpload(e.status, e.body) : "retry";
  }
}

/// Sends every stored, unquarantined chunk of a meeting in order. Returns
/// "done" when nothing is left to send, else why it stopped.
export async function drainMeeting(server, token, meetingId) {
  for (const c of await pendingChunks(meetingId)) {
    if (c.quarantined) continue;
    const outcome = await uploadChunk(server, token, c);
    if (outcome === "ack") await deleteChunk(c.meetingId, c.seq);
    else if (outcome === "quarantine")
      await putChunk({ ...c, quarantined: true });
    else return outcome;
  }
  return "done";
}

/// Which missing chunks may be given up on: only ones this device does not
/// have, or holds as quarantined. Anything still uploadable blocks finalize.
export function acceptableGaps(missing, localChunks) {
  const local = new Map(localChunks.map((c) => [c.seq, c]));
  return missing.every((seq) => !local.has(seq) || local.get(seq).quarantined);
}

export const STOP_REASONS = {
  1: "user_stopped",
  2: "meeting_ended",
  3: "tab_closed",
  4: "window_closed",
  5: "device_lost",
  6: "prolonged_inactivity",
  7: "hard_limit",
};
export const SIGNAL = {
  userStop: 1,
  meetingEnded: 2,
  tabClosed: 3,
  windowClosed: 4,
  navigatedAway: 5,
  returned: 6,
  deviceLost: 7,
  deviceRestored: 8,
  keepRecording: 9,
  pause: 10,
  resume: 11,
};
