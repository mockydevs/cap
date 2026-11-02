// Local only: signs in to the LOCAL Calari test API with the protected fixture login and
// creates a fresh client pairing code. Prints nothing secret.
import { readFile, writeFile } from "node:fs/promises";
const api = "http://127.0.0.1:4105/api/v1";
if (new URL(api).hostname !== "127.0.0.1") throw new Error("local only");
const [clientId, outFile] = process.argv.slice(2);
const login = JSON.parse(
  await readFile(
    "/home/don/.config/mocky/secrets/calari-cap-flow-login.json",
    "utf8",
  ),
);
const r = await fetch(`${api}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: login.email, password: login.password }),
});
if (!r.ok) throw new Error(`login HTTP ${r.status}`);
const jar = Object.fromEntries(
  (r.headers.getSetCookie?.() ?? [])
    .map((l) => l.split(";")[0].split("="))
    .map(([k, ...v]) => [k.trim(), v.join("=")]),
);
if (!jar.calari_session || !jar.calari_csrf)
  throw new Error("no session cookies");
const p = await fetch(`${api}/integrations/cap/clients/${clientId}/pairings`, {
  method: "POST",
  headers: {
    cookie: `calari_session=${jar.calari_session}; calari_csrf=${jar.calari_csrf}`,
    "x-csrf-token": jar.calari_csrf,
    "content-type": "application/json",
  },
  body: JSON.stringify({ requestId: crypto.randomUUID() }),
});
if (!p.ok) throw new Error(`pairing HTTP ${p.status}`);
const { code } = await p.json();
await writeFile(outFile, code, { mode: 0o600 });
console.log(
  JSON.stringify({
    login: r.status,
    pairing: p.status,
    codeLength: code.length,
  }),
);
