// Service worker: owns pairing, recording lifecycle and calendar reminders.
// Chrome only allows tab capture after the user invokes the extension (popup,
// toolbar click or keyboard shortcut), so a scheduled meeting gets a
// reminder with one click to start, never a silent recording.

import { CALARI_ORIGIN, CAP_SERVER, CONNECT_PATH } from "./config.js";
import {
  ApiError,
  MARKER,
  SIGNAL,
  acceptableGaps,
  api,
  drainMeeting,
  isMeetingUrl,
  pendingChunks,
} from "./shared.js";

const get = async (k) => (await chrome.storage.local.get(k))[k];
const set = (o) => chrome.storage.local.set(o);

async function device() {
  const d = await get("device");
  const expiresAt = Date.parse(d?.expiresAt);
  if (!d || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return d;
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "src/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Record the meeting tab the user chose to capture",
  });
}

const toOffscreen = (msg) =>
  chrome.runtime.sendMessage({ target: "offscreen", ...msg });

function badge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

async function pair({ code, deviceName, verifier }) {
  const server = CAP_SERVER;
  const res = await api(server, null, "/v1/pairings/redeem", {
    method: "POST",
    json: {
      code,
      device_name: deviceName || "Chrome",
      device_kind: "extension",
      ...(verifier ? { code_verifier: verifier } : {}),
    },
  });
  await set({
    server,
    device: {
      token: res.device_token,
      expiresAt: res.expires_at,
      clientName: res.client_display_name,
      pairingKind: res.pairing_kind,
    },
  });
  void recover().catch(() => {});
  return {
    clientName: res.client_display_name,
    pairingKind: res.pairing_kind,
    expiresAt: res.expires_at,
  };
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// "Sign in with Calari": the person signs in on Calari's own page (portal
// username or email and password) and chooses the client or an internal
// meeting there. Calari hands back a pairing code bound to this sign-in by
// PKCE, so the code alone is useless to anyone who sees it. Portal
// credentials never pass through the extension or Cap.
async function signInWithCalari({ mode }) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const redirect = chrome.identity.getRedirectURL("calari");
  const url = new URL(CONNECT_PATH, CALARI_ORIGIN);
  url.search = new URLSearchParams({
    redirect_uri: redirect,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    mode: mode === "video" ? "video" : "audio",
  }).toString();
  const result = await chrome.identity.launchWebAuthFlow({
    url: url.href,
    interactive: true,
  });
  const back = new URL(result);
  const expected = new URL(redirect);
  if (back.origin !== expected.origin || back.pathname !== expected.pathname)
    throw new Error("Unexpected sign-in response.");
  if (back.searchParams.get("state") !== state)
    throw new Error("The sign-in response did not match. Try again.");
  const code = back.searchParams.get("code");
  if (!code)
    throw new Error(
      back.searchParams.get("error_description") || "Sign-in was cancelled.",
    );
  return pair({ code, deviceName: "Chrome extension", verifier });
}

async function startRecording({ tabId, streamId, mode }) {
  const d = await device();
  if (!d) throw new Error("Sign in with Calari and choose a client first.");
  if (await get("active")) throw new Error("Cap is already recording.");
  const server = await get("server");
  const tab = await chrome.tabs.get(tabId);
  const options = (await get("options")) ?? {};
  const meeting = await api(server, d.token, "/v1/meetings", {
    method: "POST",
    json: {
      title: (tab.title || "Meeting").slice(0, 200),
      idempotency_key: crypto.randomUUID(),
      started_at: new Date().toISOString(),
      capture_mode: mode === "video" ? "video" : "audio",
      meeting_url: isMeetingUrl(tab.url) ? tab.url : null,
    },
  }).catch(async (error) => {
    if (error instanceof ApiError && error.status === 401) {
      await chrome.storage.local.remove("device");
      throw new Error("Your Calari sign-in expired. Sign in again to start recording.");
    }
    throw error;
  });
  await ensureOffscreen();
  const res = await toOffscreen({
    type: "start",
    streamId,
    mode,
    meetingId: meeting.id,
    server,
    token: d.token,
    useMic: options.useMic !== false,
  });
  if (!res?.ok) throw new Error(res?.error || "Could not start recording");
  // The meeting keeps the credential it was created with, so pairing with
  // another client later cannot strand its audio.
  await set({
    active: {
      meetingId: meeting.id,
      tabId,
      mode,
      startedAt: Date.now(),
      wasOnMeeting: isMeetingUrl(tab.url),
      server,
      token: d.token,
    },
  });
  badge("REC", "#c62828");
  return { meetingId: meeting.id };
}

// Meetings waiting to upload or finalize, keyed by meeting id. Each keeps
// its own server and token.
async function unfinished() {
  return (await get("unfinished")) ?? {};
}

async function saveUnfinished(m) {
  await set({ unfinished: { ...(await unfinished()), [m.meetingId]: m } });
}

async function dropUnfinished(meetingId) {
  const all = await unfinished();
  delete all[meetingId];
  await set({ unfinished: all });
}

/// Uploads what is stored, then finalizes. Gaps are accepted only for audio
/// this browser does not have or holds as quarantined; audio still waiting
/// to upload keeps the meeting open, because the server refuses chunks after
/// finalize. Returns "done", "retry" or "reauth".
async function adoptMeeting(m) {
  // A new pairing can resume only its own client's recording; the server
  // authorizes adoption and preserves the meeting's original binding.
  const current = await device();
  if (!current || current.token === m.token || (await get("server")) !== m.server)
    return false;
  try {
    await api(m.server, current.token, `/v1/meetings/${m.meetingId}/adopt`, { method: "POST" });
    m.token = current.token;
    await saveUnfinished(m);
    return true;
  } catch {
    return false;
  }
}

async function refreshLastSeq(m) {
  let view;
  try {
    view = await api(m.server, m.token, `/v1/meetings/${m.meetingId}`);
  } catch (error) {
    if (error instanceof ApiError && [401, 404].includes(error.status) && await adoptMeeting(m))
      return refreshLastSeq(m);
    throw error;
  }
  if (!Number.isInteger(view?.received_chunks) || !Array.isArray(view?.missing_chunks))
    throw new Error("Could not recover the recording's final chunk number.");
  m.lastSeq = Math.max(0, view.received_chunks + view.missing_chunks.length - 1);
  await saveUnfinished(m);
}

async function settle(m) {
  let outcome = await drainMeeting(m.server, m.token, m.meetingId);
  if (outcome === "reauth" && await adoptMeeting(m))
    outcome = await drainMeeting(m.server, m.token, m.meetingId);
  if (outcome !== "done") return outcome;
  if (!Number.isInteger(m.lastSeq) || m.lastSeq < 0) {
    try {
      await refreshLastSeq(m);
    } catch (error) {
      return error instanceof ApiError && [401, 404].includes(error.status) ? "reauth" : "retry";
    }
  }
  const body = {
    last_seq: Math.max(0, m.lastSeq),
    stop_reason: m.reason,
    ended_at: m.endedAt ?? new Date().toISOString(),
    allow_missing: false,
  };
  const path = `/v1/meetings/${m.meetingId}/finalize`;
  try {
    await api(m.server, m.token, path, { method: "POST", json: body });
    return "done";
  } catch (e) {
    if (!(e instanceof ApiError)) return "retry";
    if (e.status === 401 || e.status === 404) {
      // Even if every chunk was uploaded, an expired credential still needs
      // adoption before finalization. No local audio needs to remain for this.
      if (await adoptMeeting(m)) return settle(m);
      return "reauth";
    }
    if (e.body?.error === "no_audio") return "done";
    if (
      e.body?.error === "missing_chunks" &&
      acceptableGaps(
        e.body.missing_chunks ?? [],
        await pendingChunks(m.meetingId),
      )
    ) {
      await api(m.server, m.token, path, {
        method: "POST",
        json: { ...body, allow_missing: true },
      });
      return "done";
    }
    return "retry";
  }
}

async function stopped({ meetingId, reason, lastSeq }) {
  const active = await get("active");
  if (!active || active.meetingId !== meetingId) return;
  const m = {
    meetingId,
    server: active.server,
    token: active.token,
    reason,
    lastSeq,
    endedAt: new Date().toISOString(),
  };
  await saveUnfinished(m);
  await chrome.storage.local.remove("active");
  badge("", null);
  const outcome = await settle(m).catch(() => "retry");
  if (outcome === "done") await dropUnfinished(meetingId);
  chrome.notifications.create(`stopped:${meetingId}`, {
    type: "basic",
    iconUrl: "src/icon.png",
    title: "Cap stopped recording",
    message:
      outcome === "done"
        ? "Sent to Calari."
        : outcome === "reauth"
          ? "Cap's pairing expired. The recording is saved in this browser and uploads after you pair with the same client again."
          : "The recording is saved in this browser. Cap keeps retrying the upload.",
  });
}

// Retries every unfinished meeting, including one interrupted by a browser
// crash (its stored chunks are uploaded and it is finalized as interrupted).
async function recover() {
  const active = await get("active");
  if (active) {
    const s = (await chrome.offscreen.hasDocument())
      ? await toOffscreen({ type: "status" }).catch(() => null)
      : null;
    // Never finalize across an unsaved chunk. If Chrome was closed while
    // saving failed, retain the failure marker instead of accepting a gap.
    if (s?.recording || s?.pendingSave || active.pendingSave) return;
    const chunks = await pendingChunks(active.meetingId);
    await saveUnfinished({
      meetingId: active.meetingId,
      server: active.server,
      token: active.token,
      reason: "interrupted",
      lastSeq: Math.max(-1, ...chunks.map((c) => c.seq)),
    });
    await chrome.storage.local.remove("active");
    badge("", null);
  }
  for (const m of Object.values(await unfinished())) {
    const outcome = await settle(m).catch(() => "retry");
    if (outcome === "done") await dropUnfinished(m.meetingId);
  }
}

// ---- Calendar: "[Cap: record audio|video]" in an event's description ----

async function calendarToken(interactive) {
  const r = await chrome.identity.getAuthToken({ interactive });
  return typeof r === "string" ? r : r?.token;
}

async function syncCalendar(interactive = false) {
  if (!(await get("calendarConnected")) && !interactive) return;
  const token = await calendarToken(interactive).catch(() => null);
  if (!token) return;
  const now = new Date();
  const url = new URL(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
  );
  url.search = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return;
  await set({ calendarConnected: true });
  const { items = [] } = await res.json();
  const scheduled = {};
  for (const ev of items) {
    const m = MARKER.exec(ev.description || "");
    const start = ev.start?.dateTime;
    if (!m || !start) continue;
    scheduled[ev.id] = {
      title: ev.summary || "Meeting",
      start,
      mode: m[1].toLowerCase(),
      link: ev.hangoutLink || null,
    };
    chrome.alarms.create(`meeting:${ev.id}`, {
      when: Math.max(Date.now() + 1000, new Date(start).getTime() - 60_000),
    });
  }
  await set({ scheduled });
}

async function remind(eventId) {
  const ev = (await get("scheduled"))?.[eventId];
  if (!ev) return;
  await set({ pendingMode: ev.mode });
  chrome.notifications.create(`remind:${eventId}`, {
    type: "basic",
    iconUrl: "src/icon.png",
    requireInteraction: true,
    title: `${ev.title} is starting`,
    message: `Cap is set to record ${ev.mode === "video" ? "video" : "audio + transcript"}. Open the meeting, then click the Cap icon and Start (or press Alt+Shift+R).`,
    buttons: ev.link ? [{ title: "Open meeting" }] : [],
  });
  if (ev.link) {
    for (const tab of await chrome.tabs.query({
      url: "https://meet.google.com/*",
    })) {
      chrome.tabs
        .sendMessage(tab.id, {
          type: "cap-scheduled",
          mode: ev.mode,
          title: ev.title,
        })
        .catch(() => {});
    }
  }
}

// ---- Events ----

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === "offscreen") return;
  const handlers = {
    pair: () => pair({ code: msg.code, deviceName: msg.deviceName }),
    signin: () => signInWithCalari(msg),
    start: () => startRecording(msg),
    stop: async () => {
      const active = await get("active");
      if (active) await set({ active: { ...active, pendingSave: true } });
      const result = await toOffscreen({ type: "stop", reason: "user_stopped" });
      if (!result?.ok)
        throw new Error(result?.error || "Could not stop recording. Try again.");
      return { ok: true };
    },
    status: async () => ({
      device: await device(),
      active: (await get("active")) ?? null,
      server: await get("server"),
      pendingMode: await get("pendingMode"),
      unfinishedCount: Object.keys(await unfinished()).length,
    }),
    "connect-calendar": () => syncCalendar(true),
    "offscreen-stopped": () => stopped(msg),
    "offscreen-save-failed": async () => {
      const active = await get("active");
      if (active?.meetingId !== msg.meetingId) return;
      await set({ active: { ...active, pendingSave: true, saveError: msg.error } });
      badge("!", "#c62828");
    },
    "offscreen-warn": () => warn(msg),
    "offscreen-notice": () =>
      chrome.notifications.create({
        type: "basic",
        iconUrl: "src/icon.png",
        title: "Cap",
        message: msg.text,
      }),
    "meet-ended": async () => {
      const a = await get("active");
      if (a && sender.tab?.id === a.tabId)
        await toOffscreen({ type: "signal", code: SIGNAL.meetingEnded });
    },
    // Unfinished meetings keep their own credential, so unpairing never
    // strands audio that is still waiting to upload.
    unpair: () => chrome.storage.local.remove(["device"]),
  };
  const h = handlers[msg.type];
  if (!h) return;
  Promise.resolve(h()).then(
    (v) => reply({ ok: true, ...(v ?? {}) }),
    (e) => reply({ ok: false, error: String(e?.message ?? e) }),
  );
  return true;
});

async function warn({ reason, stopAtMs }) {
  const mins = Math.max(0, Math.round((stopAtMs - Date.now()) / 60_000));
  const text =
    reason === 10
      ? `No one has spoken for a while. Cap stops in about ${mins} min unless you keep recording.`
      : reason === 11
        ? `Cap reaches its maximum length in about ${mins} min.`
        : `The meeting tab left the call. Cap stops in about ${mins} min if it does not come back.`;
  badge("!", "#f9a825");
  await set({ warnReason: reason });
  chrome.notifications.create("warn", {
    type: "basic",
    iconUrl: "src/icon.png",
    title: "Still in the meeting?",
    message: text,
    requireInteraction: true,
    buttons:
      reason === 10
        ? [{ title: "Keep recording" }, { title: "Stop now" }]
        : [{ title: "Stop now" }],
  });
}

chrome.notifications.onButtonClicked.addListener(async (id, index) => {
  if (id === "warn") {
    chrome.notifications.clear("warn");
    badge("REC", "#c62828");
    const canKeep = (await get("warnReason")) === 10;
    if (canKeep && index === 0)
      await toOffscreen({ type: "signal", code: SIGNAL.keepRecording });
    else await toOffscreen({ type: "stop", reason: "user_stopped" });
  } else if (id.startsWith("remind:")) {
    const ev = (await get("scheduled"))?.[id.slice(7)];
    if (ev?.link) chrome.tabs.create({ url: ev.link });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const a = await get("active");
  if (a?.tabId === tabId)
    await toOffscreen({ type: "signal", code: SIGNAL.tabClosed }).catch(
      () => {},
    );
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const a = await get("active");
  if (!a || a.tabId !== tabId || !info.url || !a.wasOnMeeting) return;
  const code = isMeetingUrl(info.url) ? SIGNAL.returned : SIGNAL.navigatedAway;
  await toOffscreen({ type: "signal", code }).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-recording") return;
  if (await get("active"))
    return toOffscreen({ type: "stop", reason: "user_stopped" });
  const target =
    tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: target.id,
  });
  const mode =
    (await get("pendingMode")) ??
    (await get("options"))?.defaultMode ??
    "audio";
  await startRecording({ tabId: target.id, streamId, mode }).catch((e) =>
    chrome.notifications.create({
      type: "basic",
      iconUrl: "src/icon.png",
      title: "Cap could not start",
      message: String(e.message),
    }),
  );
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "calendar-sync") syncCalendar();
  else if (alarm.name === "retry-uploads") recover();
  else if (alarm.name.startsWith("meeting:")) remind(alarm.name.slice(8));
});

chrome.runtime.onStartup.addListener(recover);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("calendar-sync", { periodInMinutes: 5 });
  chrome.alarms.create("retry-uploads", { periodInMinutes: 5 });
  recover();
});
