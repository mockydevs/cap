// Real-Chromium check of the extension's offscreen microphone behaviour.
// Usage: node repro.mjs <unpacked-extension-dir> <chrome-binary>
// Fresh throwaway profile, fake capture devices, no auto-accept of prompts.
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const outDir = process.argv[4];
const later = Date.now() + 6 * 3600_000;
const device = {
  token: "synthetic-screenshot-only",
  expiresAt: new Date(later).toISOString(),
  clientName: "Example Client Ltd",
  pairingKind: "client_intake",
};
const states = {
  "1-sign-in": { clear: true },
  "2-ready": { set: { device, server: "https://meetings.calari.tech" } },
  "3-recording": {
    set: {
      device,
      server: "https://meetings.calari.tech",
      active: {
        meetingId: "synthetic",
        tabId: 0,
        mode: "audio",
        startedAt: Date.now(),
        server: "https://meetings.calari.tech",
        token: "synthetic-screenshot-only",
      },
    },
  },
};
const css = `html{background:#eef1f6;min-height:100%;display:flex;align-items:center;justify-content:center}body{zoom:1.3;width:360px;border-radius:10px;box-shadow:0 6px 24px rgba(16,24,40,.18)}`;
async function shot(name, page) {
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const s = (await cdp("Target.attachToTarget", { targetId, flatten: true }))
    .sessionId;
  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    s,
  );
  await cdp(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-color-scheme", value: "light" }] },
    s,
  );
  await cdp("Page.enable", {}, s);
  await cdp(
    "Page.navigate",
    { url: `chrome-extension://${extId}/src/${page}` },
    s,
  );
  await new Promise((r) => setTimeout(r, 1500));
  await evalIn(
    s,
    `(() => { const st = document.createElement("style"); st.textContent = ${JSON.stringify(page === "popup.html" ? css : "html{background:#eef1f6}body{background:#fff;padding:32px 40px;zoom:1.25;margin-top:24px!important;border-radius:10px}")}; document.head.append(st); return 1 })()`,
  );
  await new Promise((r) => setTimeout(r, 400));
  const { data } = await cdp("Page.captureScreenshot", { format: "png" }, s);
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, "base64"));
  await cdp("Target.closeTarget", { targetId });
}
for (const [name, st] of Object.entries(states)) {
  await evalIn(
    swS,
    `chrome.storage.local.clear().then(() => chrome.storage.local.set(${JSON.stringify(st.set ?? {})})).then(() => "ok")`,
  );
  await shot(name, "popup.html");
}
await evalIn(swS, `chrome.storage.local.clear().then(() => "ok")`);
await shot("4-options", "options.html");
console.log("shots done");
ws.close();
chrome.kill();
await new Promise((r) => setTimeout(r, 300));
rmSync(profile, { recursive: true, force: true });
