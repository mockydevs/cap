import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;
let listener;
let store;
let authFlow;
let requests;
let offscreenReply;
let responseStatus;
let fetchHandler;
let toOffscreen;
let offscreenOpen;
let offscreenCreated;
const event = () => ({ addListener() {} });
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return { [key]: store[key] };
      },
      async set(values) {
        Object.assign(store, values);
      },
      async remove(keys) {
        for (const k of [keys].flat()) delete store[k];
      },
    },
  },
  identity: {
    getRedirectURL: () =>
      "https://edoidpfmflnlhjkmaimdamkmokaphcba.chromiumapp.org/calari",
    launchWebAuthFlow: (options) => authFlow(options),
  },
  runtime: {
    onMessage: {
      addListener(fn) {
        listener = fn;
      },
    },
    onStartup: event(),
    onInstalled: event(),
    async sendMessage(message) {
      toOffscreen.push(message);
      return typeof offscreenReply === "function"
        ? offscreenReply(message)
        : offscreenReply;
    },
  },
  notifications: { onButtonClicked: event() },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  offscreen: {
    async hasDocument() {
      return offscreenOpen;
    },
    async createDocument() {
      offscreenOpen = true;
      offscreenCreated++;
    },
    async closeDocument() {
      offscreenOpen = false;
    },
  },
  tabs: {
    async get() {
      return { title: "Synthetic", url: "http://127.0.0.1:8844/" };
    },
    onRemoved: event(),
    onUpdated: event(),
  },
  commands: { onCommand: event() },
  alarms: { onAlarm: event() },
};
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  if (fetchHandler) return fetchHandler(url, options);
  return new Response(
    JSON.stringify({
      device_token: "test-only",
      expires_at: "2099-01-01",
      client_display_name: "Synthetic client",
      pairing_kind: "client",
    }),
    { status: responseStatus },
  );
};
// Empty durable chunk store: all audio has already been acknowledged.
globalThis.indexedDB = {
  open() {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        transaction() {
          const transaction = {
            objectStore: () => ({ getAll: () => ({ result: [] }) }),
          };
          queueMicrotask(() => transaction.oncomplete());
          return transaction;
        },
      };
      request.onsuccess();
    });
    return request;
  },
};
await import("../src/background.js");
const send = (message) =>
  new Promise((resolve) => listener(message, {}, resolve));
beforeEach(() => {
  store = {};
  requests = [];
  offscreenReply = { ok: true };
  responseStatus = 200;
  fetchHandler = null;
  toOffscreen = [];
  offscreenOpen = false;
  offscreenCreated = 0;
});

test("Calari sign-in binds redemption to state, exact callback and S256 verifier", async () => {
  let connect;
  authFlow = async ({ url, interactive }) => {
    assert.equal(interactive, true);
    connect = new URL(url);
    assert.equal(connect.origin, "https://calarisolutions.com");
    assert.equal(connect.pathname, "/portal/recorder/connect");
    assert.equal(connect.searchParams.get("mode"), "video");
    assert.equal(connect.searchParams.get("code_challenge_method"), "S256");
    const back = new URL(connect.searchParams.get("redirect_uri"));
    back.searchParams.set("state", connect.searchParams.get("state"));
    back.searchParams.set("code", "TEST-CODE");
    return back.href;
  };
  const response = await send({ type: "signin", mode: "video" });
  assert.equal(response.ok, true);
  const redeem = JSON.parse(requests[0].options.body);
  assert.equal(
    requests[0].url,
    "https://meetings.calari.tech/v1/pairings/redeem",
  );
  assert.equal(redeem.device_kind, "extension");
  assert.equal(redeem.code, "TEST-CODE");
  assert.match(redeem.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  const challenge = Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(redeem.code_verifier),
    ),
  ).toString("base64url");
  assert.equal(challenge, connect.searchParams.get("code_challenge"));
});

for (const failure of ["state", "origin", "path"]) {
  test(`sign-in refuses a changed callback ${failure} before redemption`, async () => {
    authFlow = async ({ url }) => {
      const connect = new URL(url);
      const back = new URL(connect.searchParams.get("redirect_uri"));
      back.searchParams.set("state", connect.searchParams.get("state"));
      back.searchParams.set("code", "TEST-CODE");
      if (failure === "state") back.searchParams.set("state", "wrong");
      if (failure === "origin") back.hostname = "example.com";
      if (failure === "path") back.pathname = "/wrong";
      return back.href;
    };
    assert.equal((await send({ type: "signin" })).ok, false);
    assert.equal(requests.length, 0);
    assert.equal(store.device, undefined);
  });
}

test("expiry returns sign-in state while preserving unfinished recordings", async () => {
  store.device = { token: "expired-test-only", expiresAt: "2000-01-01" };
  store.unfinished = { synthetic: { meetingId: "synthetic" } };
  const status = await send({ type: "status" });
  assert.equal(status.device, null);
  assert.equal(status.unfinishedCount, 1);
  assert.ok(store.unfinished.synthetic);
});

test("Stop reports offscreen errors and retains recording state", async () => {
  store.active = { meetingId: "synthetic" };
  offscreenReply = { ok: false, error: "storage full" };
  assert.deepEqual(await send({ type: "stop" }), {
    ok: false,
    error: "storage full",
  });
  assert.ok(store.active);
});

test("a revoked credential opens sign-in again without deleting recordings", async () => {
  store.device = { token: "revoked-test-only", expiresAt: "2099-01-01" };
  store.server = "https://meetings.calari.tech";
  store.unfinished = { synthetic: { meetingId: "synthetic" } };
  responseStatus = 401;
  const response = await send({ type: "start", tabId: 1 });
  assert.equal(response.ok, false);
  assert.match(response.error, /sign-in expired/);
  assert.equal(store.device, undefined);
  assert.ok(store.unfinished.synthetic);
});

test("re-pairing adopts an expired meeting even after all chunks uploaded", async () => {
  store.server = "https://meetings.calari.tech";
  store.unfinished = {
    synthetic: {
      meetingId: "synthetic",
      server: store.server,
      token: "old-test-only",
      lastSeq: 1,
      reason: "user_stopped",
    },
  };
  fetchHandler = (url, options) => {
    if (url.endsWith("/redeem"))
      return new Response(
        JSON.stringify({
          device_token: "new-test-only",
          expires_at: "2099-01-01",
        }),
      );
    if (url.endsWith("/adopt")) {
      assert.equal(options.headers.authorization, "Bearer new-test-only");
      return new Response("{}");
    }
    assert.ok(url.endsWith("/finalize"));
    return new Response("{}", {
      status:
        options.headers.authorization === "Bearer old-test-only" ? 401 : 200,
    });
  };
  assert.equal((await send({ type: "pair", code: "TEST-CODE" })).ok, true);
  for (let n = 0; n < 20 && store.unfinished.synthetic; n++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.unfinished.synthetic, undefined);
  assert.deepEqual(
    requests.map((r) => r.url.split("/").at(-1)),
    ["redeem", "finalize", "adopt", "finalize"],
  );
});

test("a delayed stop from another meeting cannot clear the current recording", async () => {
  store.active = { meetingId: "new-synthetic" };
  assert.equal(
    (
      await send({
        type: "offscreen-stopped",
        meetingId: "old-synthetic",
        lastSeq: 0,
      })
    ).ok,
    true,
  );
  assert.equal(store.active.meetingId, "new-synthetic");
  assert.equal(store.unfinished, undefined);
});

test("crash with acknowledged chunks refreshes unknown sequence after renewed pairing", async () => {
  store.server = "https://meetings.calari.tech";
  store.active = {
    meetingId: "synthetic",
    server: store.server,
    token: "old-test-only",
  };
  fetchHandler = (url, options) => {
    if (url.endsWith("/redeem"))
      return new Response(
        JSON.stringify({
          device_token: "new-test-only",
          expires_at: "2099-01-01",
        }),
      );
    if (url.endsWith("/adopt")) return new Response("{}");
    if (url.endsWith("/synthetic"))
      return options.headers.authorization === "Bearer old-test-only"
        ? new Response("{}", { status: 401 })
        : new Response(
            JSON.stringify({ received_chunks: 3, missing_chunks: [] }),
          );
    assert.ok(url.endsWith("/finalize"));
    assert.equal(options.headers.authorization, "Bearer new-test-only");
    assert.equal(store.unfinished.synthetic.lastSeq, 2);
    assert.equal(JSON.parse(options.body).last_seq, 2);
    return new Response("{}");
  };
  assert.equal((await send({ type: "pair", code: "TEST-CODE" })).ok, true);
  for (let n = 0; n < 30 && (store.active || store.unfinished?.synthetic); n++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.active, undefined);
  assert.equal(store.unfinished.synthetic, undefined);
  assert.deepEqual(
    requests.map((r) => r.url.split("/").at(-1)),
    ["redeem", "synthetic", "adopt", "synthetic", "finalize"],
  );
});

test("crash recovery never finalizes a persisted unsaved-audio marker", async () => {
  store.server = "https://meetings.calari.tech";
  store.active = {
    meetingId: "synthetic",
    server: store.server,
    token: "old-test-only",
    pendingSave: true,
  };
  assert.equal((await send({ type: "pair", code: "TEST-CODE" })).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(store.active.pendingSave);
  assert.deepEqual(
    requests.map((r) => r.url.split("/").at(-1)),
    ["redeem"],
  );
});

// The recorder page cannot ask for the microphone, so Start checks first and
// never creates a meeting that would silently record the tab alone.
const meetingRequests = () =>
  requests.filter((r) => String(r.url).endsWith("/v1/meetings"));
function readyToStart(options) {
  store.device = { token: "test-only", expiresAt: "2099-01-01" };
  store.server = "https://meetings.calari.tech";
  if (options) store.options = options;
}

test("Start refuses before creating a meeting when the microphone is not allowed", async () => {
  readyToStart();
  offscreenReply = (m) =>
    m.type === "mic-check"
      ? { ok: false, error: "NotAllowedError" }
      : { ok: true };
  const response = await send({ type: "start", tabId: 1, mode: "audio" });
  assert.equal(response.ok, false);
  assert.match(response.error, /has not allowed it/);
  assert.equal(meetingRequests().length, 0);
  // Retried once in a new recorder page, then gave up.
  assert.equal(toOffscreen.filter((m) => m.type === "mic-check").length, 2);
  assert.equal(offscreenCreated, 2);
  assert.equal(
    toOffscreen.some((m) => m.type === "start"),
    false,
  );
  assert.equal(store.active, undefined);
});

test("a recorder page opened before the grant is replaced and recording starts", async () => {
  readyToStart();
  let checks = 0;
  offscreenReply = (m) =>
    m.type === "mic-check" ? { ok: ++checks > 1 } : { ok: true };
  fetchHandler = async () =>
    new Response(JSON.stringify({ id: "synthetic-meeting" }), { status: 200 });
  const response = await send({ type: "start", tabId: 1, mode: "audio" });
  assert.equal(response.ok, true);
  assert.equal(offscreenCreated, 2);
  assert.equal(meetingRequests().length, 1);
  const start = toOffscreen.find((m) => m.type === "start");
  assert.equal(start.useMic, true);
  assert.equal(store.active.meetingId, "synthetic-meeting");
});

test("with the microphone turned off, Start records the tab without a check", async () => {
  readyToStart({ useMic: false });
  fetchHandler = async () =>
    new Response(JSON.stringify({ id: "synthetic-meeting" }), { status: 200 });
  const response = await send({ type: "start", tabId: 1, mode: "audio" });
  assert.equal(response.ok, true);
  assert.equal(
    toOffscreen.some((m) => m.type === "mic-check"),
    false,
  );
  assert.equal(toOffscreen.find((m) => m.type === "start").useMic, false);
});
