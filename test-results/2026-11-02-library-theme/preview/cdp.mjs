import { spawn } from "node:child_process";
const [file, port] = [process.argv[2], 9333];
const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    "--user-data-dir=" + process.argv[3],
    "about:blank",
  ],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(
      (t) => t.type === "page",
    );
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = {};
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending[d.id]) {
    pending[d.id](d.result);
    delete pending[d.id];
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending[i] = r;
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (e) =>
  (await send("Runtime.evaluate", { expression: e, returnByValue: true }))
    .result.value;
await send("Page.navigate", { url: "file://" + file });
await sleep(800);
const border = `getComputedStyle(document.getElementById('r')).borderTopColor`;
const base = await ev(border);
const key = async (k, code, vk) => {
  for (const type of ["keyDown", "keyUp"])
    await send("Input.dispatchKeyEvent", {
      type,
      key: k,
      code,
      windowsVirtualKeyCode: vk,
    });
};
await key("Tab", "Tab", 9);
await sleep(200);
const focused = await ev(border),
  fv = await ev(`document.getElementById('r').matches(':focus-visible')`);
const box = await ev(
  `(()=>{const b=document.getElementById('r').getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`,
);
await send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: box[0],
  y: box[1],
});
await sleep(200);
const both = await ev(border),
  hov = await ev(`document.getElementById('r').matches(':hover')`);
await key("Tab", "Tab", 9);
await sleep(200);
const hoverOnly = await ev(border);
console.log(
  JSON.stringify({
    base,
    focused,
    focusVisible: fv,
    hoverAndFocus: both,
    hovered: hov,
    hoverOnly,
  }),
);
ws.close();
chrome.kill();
