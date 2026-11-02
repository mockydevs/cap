// Real-Chromium check of the extension's offscreen microphone behaviour.
// Usage: node repro.mjs <unpacked-extension-dir> <chrome-binary>
// Fresh throwaway profile, fake capture devices, no auto-accept of prompts.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [ext, bin] = process.argv.slice(2);
const profile = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "cap-mic-"));
const chrome = spawn(
  bin,
  [
    "--headless=new",
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    "--remote-debugging-port=0",
    "--use-fake-device-for-media-stream",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TMPDIR: "/tmp" },
  },
);

chrome.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
chrome.on("exit", (c) => console.error("chrome exited", c));
const portFile = join(profile, "DevToolsActivePort");
for (let i = 0; i < 600 && !existsSync(portFile); i++)
  await new Promise((r) => setTimeout(r, 100));
const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  }
};
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, (m) =>
      m.error ? reject(new Error(m.error.message)) : resolve(m.result),
    );
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
const evalIn = async (sessionId, expression) => {
  const r = await cdp(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  return r.result.value ?? r.exceptionDetails?.exception?.description;
};
const find = async (pred) => {
  for (let i = 0; i < 400; i++) {
    const { targetInfos } = await cdp("Target.getTargets");
    const t = targetInfos.find(pred);
    if (t) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("target not found");
};
const attach = async (t) =>
  (await cdp("Target.attachToTarget", { targetId: t.targetId, flatten: true }))
    .sessionId;

const sw = await find(
  (t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"),
);
const extId = new URL(sw.url).host;
const swS = await attach(sw);
for (
  let i = 0;
  i < 100 && (await evalIn(swS, "typeof chrome?.offscreen")) !== "object";
  i++
)
  await new Promise((r) => setTimeout(r, 100));
console.error(
  "create:",
  await evalIn(swS, `chrome.offscreen.hasDocument()`),
  await evalIn(
    swS,
    `chrome.offscreen.createDocument({url:"src/offscreen.html",reasons:["USER_MEDIA"],justification:"repro"}).then(()=>"ok")`,
  ),
);
const off = await find((t) => t.url.endsWith("/src/offscreen.html"));
const offS = await attach(off);

const probe = `(async () => {
  const perm = (await navigator.permissions.query({ name: "microphone" })).state;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const tracks = s.getAudioTracks().map((t) => t.label);
    s.getTracks().forEach((t) => t.stop());
    return { permission: perm, getUserMedia: "ok", tracks };
  } catch (e) {
    return { permission: perm, getUserMedia: e.name + ": " + e.message };
  }
})()`;

const check = () =>
  evalIn(
    swS,
    `chrome.runtime.sendMessage({ target: "offscreen", type: "mic-check" })`,
  );
const out = {
  extensionId: extId,
  chromium: (await cdp("Browser.getVersion")).product,
};
out.micCheckBeforeGrant = await check();
await cdp("Browser.grantPermissions", {
  origin: `chrome-extension://${extId}`,
  permissions: ["audioCapture"],
});
out.micCheckAfterGrantSamePage = await check();
await evalIn(
  swS,
  `chrome.offscreen.closeDocument().then(()=>chrome.offscreen.createDocument({url:"src/offscreen.html",reasons:["USER_MEDIA"],justification:"repro"})).then(()=>"ok")`,
);
out.micCheckAfterGrantNewPage = await check();
console.log(JSON.stringify(out, null, 2));
ws.close();
chrome.kill();
await new Promise((r) => setTimeout(r, 300));
rmSync(profile, { recursive: true, force: true });
