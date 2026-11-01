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

$("signinBtn").onclick = async () => {
  show(null);
  const r = await send({ type: "signin", mode: "audio" });
  if (!r.ok)
    return show(
      r.error.includes("404")
        ? "That sign-in expired or was already used. Try again."
        : r.error,
    );
  render();
};

$("pairBtn").onclick = async () => {
  show(null);
  const r = await send({
    type: "pair",
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
