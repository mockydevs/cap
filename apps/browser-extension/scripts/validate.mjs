import { readFile } from "node:fs/promises";
const root = new URL("../src/", import.meta.url);

const manifests = {};
for (const name of ["manifest.chromium.json", "manifest.firefox.json"]) {
  const manifest = JSON.parse(await readFile(new URL(name, root), "utf8"));
  if (manifest.manifest_version !== 3 || !manifest.action?.default_popup)
    throw new Error(`${name} is not a valid MV3 Cap extension`);
  manifests[name] = manifest;
}

const chromiumPermissions =
  manifests["manifest.chromium.json"].permissions ?? [];
for (const required of [
  "offscreen",
  "tabCapture",
  "desktopCapture",
  "identity",
  "notifications",
])
  if (!chromiumPermissions.includes(required))
    throw new Error(
      `manifest.chromium.json is missing the "${required}" permission required by the recording code`,
    );

const firefoxPermissions = manifests["manifest.firefox.json"].permissions ?? [];
const expectedFirefoxPermissions = ["storage", "tabs", "contextMenus"];
if (
  firefoxPermissions.length !== expectedFirefoxPermissions.length ||
  !expectedFirefoxPermissions.every((permission) =>
    firefoxPermissions.includes(permission),
  )
) {
  throw new Error(
    `manifest.firefox.json's permissions must remain exactly ${JSON.stringify(
      expectedFirefoxPermissions,
    )} (got ${JSON.stringify(firefoxPermissions)}) — Firefox's feature set never changes`,
  );
}

for (const name of [
  "background.firefox.js",
  "background.chromium.js",
  "popup.firefox.html",
  "popup.firefox.js",
  "popup.chromium.html",
  "popup.chromium.js",
  "popup.css",
  "offscreen.html",
  "offscreen.js",
  "controls.html",
  "controls.js",
  "lib/auth.js",
  "lib/google-auth.js",
  "icon16.png",
  "icon48.png",
  "icon128.png",
])
  if (!(await readFile(new URL(name, root))).length)
    throw new Error(`${name} is empty`);
