// Local only. Admin (protected fixture login, LOCAL Calari 4105) opens the GUI meeting in the
// current Cap library THROUGH the https front (127.0.0.1:8790, SNI localhost), trusting only the
// running proxy's own certificate. Prints statuses only.
import { readFile } from "node:fs/promises";
import { request } from "node:https";
const [certFile, capMeetingId, expectTitle] = process.argv.slice(2);
const ca = await readFile(certFile);
const api = "http://127.0.0.1:4105/api/v1";
const capPublic = "https://localhost:8790";
const tls = (path, cookie, headers = {}) =>
  new Promise((ok, fail) => {
    const q = request(
      {
        host: "127.0.0.1",
        servername: "localhost",
        port: 8790,
        path,
        ca,
        headers: { ...(cookie ? { cookie } : {}), ...headers },
      },
      (r) => {
        const c = [];
        r.on("data", (d) => c.push(d));
        r.on("end", () =>
          ok({
            status: r.statusCode,
            headers: r.headers,
            cookies: [r.headers["set-cookie"] ?? []].flat(),
            body: Buffer.concat(c),
          }),
        );
      },
    );
    q.on("error", fail);
    q.end();
  });
const jarOf = (lines) =>
  Object.fromEntries(
    lines
      .map((l) => l.split(";")[0])
      .map((p) => [
        p.slice(0, p.indexOf("=")).trim(),
        p.slice(p.indexOf("=") + 1),
      ]),
  );
const hdr = (j) =>
  Object.entries(j)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
const out = {};
const page = `/meetings/${capMeetingId}`;
out.signedOut = {
  page: (await tls(page)).status,
  audio: (await tls(`${page}/parts/0`)).status,
};
const login = JSON.parse(
  await readFile(
    "/home/don/.config/mocky/secrets/calari-cap-flow-login.json",
    "utf8",
  ),
);
const l = await fetch(`${api}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: login.email, password: login.password }),
});
const cal = jarOf(l.headers.getSetCookie());
const start = await tls("/login");
const authorize = new URL(start.headers.location);
const grant = Object.fromEntries(
  ["redirect_uri", "state", "code_challenge", "code_challenge_method"].map(
    (k) => [k, authorize.searchParams.get(k)],
  ),
);
out.login = {
  status: start.status,
  authorize: `${authorize.origin}${authorize.pathname}`,
  redirect_uri: grant.redirect_uri,
};
const a = await fetch(`${api}/integrations/cap/library/authorize`, {
  method: "POST",
  headers: {
    cookie: `calari_session=${cal.calari_session}; calari_csrf=${cal.calari_csrf}`,
    "x-csrf-token": cal.calari_csrf,
    "content-type": "application/json",
  },
  body: JSON.stringify(grant),
});
out.approve = a.status;
const cb = new URL((await a.json()).redirectUrl);
if (cb.origin !== capPublic)
  throw new Error("callback not on Cap https origin");
const signed = await tls(
  `${cb.pathname}${cb.search}`,
  hdr(jarOf(start.cookies)),
);
const web = { ...jarOf(start.cookies), ...jarOf(signed.cookies) };
out.callback = signed.status;
const list = await tls("/meetings", hdr(web));
out.list = {
  status: list.status,
  hasTitle: list.body.toString().includes(expectTitle),
};
const p = await tls(page, hdr(web));
const html = p.body.toString();
out.page = {
  status: p.status,
  transcript: html.includes("Transcript"),
  playlist: html.includes("data-parts"),
  segments: (html.match(/class="ts"/g) || []).length,
};
const part = await tls(`${page}/parts/0`, hdr(web), { range: "bytes=0-1023" });
out.audio = {
  status: part.status,
  type: part.headers["content-type"],
  bytes: part.body.length,
};
console.log(JSON.stringify(out, null, 1));
