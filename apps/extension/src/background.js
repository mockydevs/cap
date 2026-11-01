// Service worker: owns pairing, recording lifecycle and calendar reminders.
// Chrome only allows tab capture after the user invokes the extension (popup,
// toolbar click or keyboard shortcut), so a scheduled meeting gets a
// reminder with one click to start, never a silent recording.

import {
  ApiError,
  MARKER,
  SIGNAL,
  api,
  isMeetingUrl,
  pendingChunks,
  uploadChunk,
  deleteChunk,
} from "./shared.js";

const get = async (k) => (await chrome.storage.local.get(k))[k];
const set = (o) => chrome.storage.local.set(o);

async function device() {
  const d = await get("device");
  if (!d || new Date(d.expiresAt) <= new Date()) return null;
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

async function pair({ server, code, deviceName }) {
  const res = await api(server, null, "/v1/pairings/redeem", {
    method: "POST",
    json: {
      code,
      device_name: deviceName || "Chrome",
      device_kind: "extension",
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
  return {
    clientName: res.client_display_name,
    pairingKind: res.pairing_kind,
    expiresAt: res.expires_at,
  };
}

async function startRecording({ tabId, streamId, mode }) {
  const d = await device();
  if (!d) throw new Error("Pair Cap with a Calari client first.");
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
  await set({
    active: {
      meetingId: meeting.id,
      tabId,
      mode,
      startedAt: Date.now(),
      wasOnMeeting: isMeetingUrl(tab.url),
    },
  });
  badge("REC", "#c62828");
  return { meetingId: meeting.id };
}

async function finalize(meetingId, reason, lastSeq) {
  const d = await get("device");
  const server = await get("server");
  if (!d || !server) return;
  const body = {
    last_seq: Math.max(0, lastSeq),
    stop_reason: reason,
    ended_at: new Date().toISOString(),
    allow_missing: false,
  };
  try {
    await api(server, d.token, `/v1/meetings/${meetingId}/finalize`, {
      method: "POST",
      json: body,
    });
  } catch (e) {
    if (e instanceof ApiError && e.body?.error === "missing_chunks") {
      // Re-send anything still stored locally, then accept the gaps.
      for (const c of await pendingChunks(meetingId))
        if (await uploadChunk(server, d.token, c))
          await deleteChunk(meetingId, c.seq);
      await api(server, d.token, `/v1/meetings/${meetingId}/finalize`, {
        method: "POST",
        json: { ...body, allow_missing: true },
      });
    } else if (!(e instanceof ApiError && e.body?.error === "no_audio")) {
      // Keep it for the recovery pass on the next start.
      await set({ unfinished: { meetingId, reason, lastSeq } });
      throw e;
    }
  }
}

async function stopped({ meetingId, reason, lastSeq }) {
  await chrome.storage.local.remove("active");
  badge("", null);
  await finalize(meetingId, reason, lastSeq).catch((e) =>
    console.warn("Cap: finalize failed", e),
  );
  chrome.notifications.create(`stopped:${meetingId}`, {
    type: "basic",
    iconUrl: "src/icon.png",
    title: "Cap stopped recording",
    message:
      reason === "user_stopped"
        ? "Uploading the transcript to Calari."
        : `Stopped (${reason.replaceAll("_", " ")}). Uploading to Calari.`,
  });
}

// Recover a recording interrupted by a browser crash: upload what was saved
// and finalize it as interrupted.
async function recover() {
  const active = await get("active");
  const unfinished = await get("unfinished");
  if (!active && !unfinished) return;
  if (await chrome.offscreen.hasDocument()) {
    const s = await toOffscreen({ type: "status" }).catch(() => null);
    if (s?.recording) return;
  }
  const d = await get("device");
  const server = await get("server");
  const id = active?.meetingId ?? unfinished.meetingId;
  let last = unfinished?.lastSeq ?? -1;
  if (d && server) {
    for (const c of await pendingChunks(id)) {
      last = Math.max(last, c.seq);
      if (await uploadChunk(server, d.token, c)) await deleteChunk(id, c.seq);
    }
    const view = await api(server, d.token, `/v1/meetings/${id}`).catch(
      () => null,
    );
    if (view?.state === "recording") {
      const seen = view.received_chunks + view.missing_chunks.length - 1;
      await api(server, d.token, `/v1/meetings/${id}/finalize`, {
        method: "POST",
        json: {
          last_seq: Math.max(last, seen, 0),
          stop_reason: unfinished?.reason ?? "interrupted",
          ended_at: new Date().toISOString(),
          allow_missing: true,
        },
      }).catch((e) => console.warn("Cap: recovery finalize failed", e));
    }
  }
  await chrome.storage.local.remove(["active", "unfinished"]);
  badge("", null);
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
    pair: () => pair(msg),
    start: () => startRecording(msg),
    stop: async () => (
      await toOffscreen({ type: "stop", reason: "user_stopped" }),
      { ok: true }
    ),
    status: async () => ({
      device: await device(),
      active: (await get("active")) ?? null,
      server: await get("server"),
      pendingMode: await get("pendingMode"),
    }),
    "connect-calendar": () => syncCalendar(true),
    "offscreen-stopped": () => stopped(msg),
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
  else if (alarm.name.startsWith("meeting:")) remind(alarm.name.slice(8));
});

chrome.runtime.onStartup.addListener(recover);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("calendar-sync", { periodInMinutes: 5 });
  recover();
});
