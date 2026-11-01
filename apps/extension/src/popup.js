const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function show(err) {
  $("error").hidden = !err;
  $("error").textContent = err ?? "";
}

async function render() {
  const s = await send({ type: "status" });
  $("pair").hidden = !!s.device;
  $("ready").hidden = !s.device || !!s.active;
  $("recording").hidden = !s.active;
  if (s.server) $("server").value = s.server;
  if (s.device) {
    const who =
      s.device.pairingKind === "internal_team"
        ? "an internal team meeting"
        : s.device.clientName || "this client";
    $("client").textContent =
      `Connected for ${who}. Expires ${new Date(s.device.expiresAt).toLocaleString()}.`;
  }
  if (s.pendingMode)
    document.querySelector(`input[name=mode][value=${s.pendingMode}]`).checked =
      true;
}

$("pairBtn").onclick = async () => {
  show(null);
  let server;
  try {
    server = new URL($("server").value.trim()).origin;
  } catch {
    return show("Enter the Cap server address.");
  }
  // Ask for access to this one server only, at the moment it is needed.
  const granted = await chrome.permissions.request({
    origins: [`${server}/*`],
  });
  if (!granted) return show("Cap needs permission to reach that server.");
  const r = await send({
    type: "pair",
    server,
    code: $("code").value,
    deviceName: "Chrome extension",
  });
  if (!r.ok)
    return show(
      r.error.includes("404")
        ? "That code is wrong, used or expired."
        : r.error,
    );
  render();
};

$("startBtn").onclick = async () => {
  show(null);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    // Allowed because the user opened Cap's popup on this tab.
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });
    const mode = document.querySelector("input[name=mode]:checked").value;
    const r = await send({ type: "start", tabId: tab.id, streamId, mode });
    if (!r.ok) return show(r.error);
    render();
  } catch (e) {
    show(String(e.message ?? e));
  }
};

$("stopBtn").onclick = async () => {
  await send({ type: "stop" });
  setTimeout(render, 500);
};

$("optionsBtn").onclick = () => chrome.runtime.openOptionsPage();
render();
