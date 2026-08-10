import { readFile } from "node:fs/promises";
const root = new URL("../src/", import.meta.url);
for (const name of ["manifest.chromium.json", "manifest.firefox.json"]) {
  const manifest = JSON.parse(await readFile(new URL(name, root), "utf8"));
  if (manifest.manifest_version !== 3 || !manifest.action?.default_popup)
    throw new Error(`${name} is not a valid MV3 Cap extension`);
}
for (const name of ["background.js", "popup.html", "popup.css", "popup.js"])
  if (!(await readFile(new URL(name, root))).length)
    throw new Error(`${name} is empty`);
