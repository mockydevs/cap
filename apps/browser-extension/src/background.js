const DEFAULT_SERVER = "http://localhost:3000";
const api = globalThis.browser ?? globalThis.chrome;

export async function server() {
  const value = await api.storage.sync.get({ serverUrl: DEFAULT_SERVER });
  return String(value.serverUrl).replace(/\/$/, "");
}

export async function open(path) {
  await api.tabs.create({ url: `${await server()}${path}` });
}

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({
      id: "cap-record",
      title: "Record with Cap",
      contexts: ["page"],
    });
    api.contextMenus.create({
      id: "cap-library",
      title: "Open Cap library",
      contexts: ["page"],
    });
  });
});
api.contextMenus.onClicked.addListener(
  (info) => void open(info.menuItemId === "cap-library" ? "/library" : "/"),
);
api.commands.onCommand.addListener((command) => {
  if (command === "start-recording") void open("/");
});
