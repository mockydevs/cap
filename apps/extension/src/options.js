const $ = (id) => document.getElementById(id);

async function load() {
  const { options = {} } = await chrome.storage.local.get("options");
  $("useMic").checked = options.useMic !== false;
  document.querySelector(
    `input[name=mode][value=${options.defaultMode ?? "audio"}]`,
  ).checked = true;
  const perm = await navigator.permissions
    .query({ name: "microphone" })
    .catch(() => null);
  $("micState").textContent = perm
    ? `Microphone permission: ${perm.state}`
    : "";
  const { calendarConnected } =
    await chrome.storage.local.get("calendarConnected");
  $("calState").textContent = calendarConnected
    ? "Connected."
    : "Not connected.";
}

async function save() {
  await chrome.storage.local.set({
    options: {
      useMic: $("useMic").checked,
      defaultMode: document.querySelector("input[name=mode]:checked").value,
    },
  });
}

$("useMic").onchange = save;
for (const r of document.querySelectorAll("input[name=mode]"))
  r.onchange = save;

$("micBtn").onclick = async () => {
  try {
    // Granting here (a visible extension page) lets the offscreen recorder use it later.
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of s.getTracks()) t.stop();
  } catch (e) {
    $("micState").textContent = `Not allowed: ${e.message}`;
    return;
  }
  load();
};

$("calBtn").onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: "connect-calendar" });
  $("calState").textContent = r.ok
    ? "Connected."
    : `Could not connect: ${r.error}`;
};

$("unpairBtn").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "unpair" });
  $("unpairBtn").textContent = "Disconnected";
};

load();
