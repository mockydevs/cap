const DEFAULT_SERVER = "http://localhost:3000";
const api = globalThis.browser ?? globalThis.chrome;
const serverInput = document.querySelector("#server");
const status = document.querySelector("#status");

const normalize = (value) => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  )
    throw new Error("Use HTTPS (HTTP is allowed only for localhost)");
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Enter only the server origin, without a path or credentials",
    );
  return url.origin;
};
async function currentServer() {
  const saved = await api.storage.sync.get({ serverUrl: DEFAULT_SERVER });
  return normalize(String(saved.serverUrl));
}
async function open(path) {
  await api.tabs.create({ url: `${await currentServer()}${path}` });
  window.close();
}

document
  .querySelector("#record")
  .addEventListener("click", () => void open("/"));
document
  .querySelector("#library")
  .addEventListener("click", () => void open("/library"));
document.querySelector("#save").addEventListener("click", async () => {
  try {
    const serverUrl = normalize(serverInput.value.trim());
    await api.storage.sync.set({ serverUrl });
    status.textContent = "Saved. Open Cap to sign in or record.";
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Invalid server URL";
  }
});
void currentServer().then((value) => {
  serverInput.value = value;
});
