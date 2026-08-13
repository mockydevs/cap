# End-to-end tests

Real-browser tests against the actual running app (auth, uploads, playback,
editing) — not mocks. They need the full local stack:

```bash
docker compose up -d           # postgres, redis, workers
pnpm --filter @cap/web db:migrate
pnpm --filter @cap/e2e exec playwright install --with-deps chromium
pnpm --filter @cap/e2e test:e2e    # starts `pnpm --filter @cap/web dev` itself
```

Set `E2E_BASE_URL` to point at an already-running app (e.g. staging) instead
of having Playwright start one:

```bash
E2E_BASE_URL=https://staging.example.com pnpm --filter @cap/e2e test:e2e
```

## Coverage

`specs/helpers.ts` has two shared, plain functions (no fixtures/page
objects): `signUpAndSignIn(page, label)`, factored out of the signup flow in
`auth.spec.ts` once a second spec file needed an authenticated user, and
`createUploadingRecording(page, title)`, documented in detail below.

None of this has been run against a live stack in this environment (no
Docker here) — every spec below was written by reading the real component
and API route source under `apps/web` for its selectors and behavior, then
re-checked side-by-side against that source, not run. See the note at the
bottom of this section for the subset that _has_ actually been executed.

### Covered

- `specs/auth.spec.ts` — login form fields, a failed-login error message,
  redirecting an unauthenticated visitor away from the library, and a full
  signup → authenticated session → sign-out round trip.
- `specs/library.spec.ts` — the library's empty state for a fresh workspace,
  and a recording created through the upload API appearing in the library
  grid with the correct title and `UPLOADING` status.
- `specs/recording-viewer.spec.ts` — **Enforce private access**: a member of
  one workspace gets "Recording not found in this workspace." when
  navigating straight to another workspace's recording URL. Also asserts the
  owner's own recording page renders its pre-processing panels (transcript
  "not complete yet" message, the AI panel's capability buttons, the
  comment form, and share controls) — see the caveat below on what this
  does and does not prove about transcription/AI/sharing.
- `specs/comments.spec.ts` — **Add a timestamped comment**: a real
  create-and-list round trip through `CommentThread` and its API route,
  which does not require the recording to have finished processing.
- `specs/admin.spec.ts` — admin/retention panel visibility for a fresh
  workspace owner (Members, Invite, Retention policy, Webhooks, API keys,
  Audit log sections all render), inviting a not-yet-registered member, and
  saving a retention policy value. This is the config-setting half of
  **Delete and recover according to policy**, not the actual
  deletion/recovery execution (see below).

### A note on how recordings get created in these specs

Several specs need a `recordings` row to exist. The only UI path to create
one is `apps/web/components/capture-studio.tsx`, which calls
`navigator.mediaDevices.getDisplayMedia()` — a native screen-picker
permission dialog with no fake-device flag equivalent to
`--use-fake-device-for-media-stream`, and headless Chromium has no screen to
share regardless. So `createUploadingRecording()` in `helpers.ts` drives the
_first_ real step of that same flow directly: an in-page `fetch` to
`POST /api/upload-sessions` (the exact endpoint and payload shape
`beginResumableUpload` in `lib/uploads/resumable-client.ts` uses), executed
with the real signed-in session cookie and same-origin `Origin` header. That
call is authorized by the same code path a genuine click would hit
(`lib/uploads/auth.ts`) and inserts a real, workspace-scoped `recordings` row
at the schema's real default status, `"UPLOADING"`. It deliberately never
completes the multipart upload (that needs a real S3-compatible endpoint),
so the recording never advances past `UPLOADING`. This is called out
explicitly rather than hidden because it's a judgment call: it is not a raw
database write, but it does skip the actual capture gesture, so treat
specs built on it as covering "a recording exists and is owned by this
workspace," not "recording and uploading a sample" end-to-end.

### Skipped, with reasons

- **Record and upload a sample** / **Resume an interrupted upload** — no
  automatable way to drive real screen capture in headless Chromium here,
  and completing a multipart upload requires a real S3-compatible endpoint.
  `library.spec.ts` covers the adjacent, narrower claim that an upload
  session's recording shows up in the library — see above for exactly what
  that does and doesn't prove.
- **Process and play a recording**, **Seek within playback** — both need a
  recording that has actually reached `READY` with a transcoded MP4 asset,
  which only the FFmpeg worker produces; there is no UI trigger for that and
  no way to fabricate it short of a direct database write, which this suite
  avoids.
- **Open an unlisted link**, **Validate password protection** — `share-
controls.tsx` can set `LINK`/`PASSWORD` visibility on any recording
  regardless of status, so a real share token can be minted. But
  `authorizeSharePlayback` (`lib/sharing/service.ts`) calls
  `playableRecording()`, which requires `status === "READY"` and a joined
  `MP4` asset row _before_ it ever checks the password — so with no way to
  reach `READY`, every share-page visit fails with the same generic
  "unavailable" message regardless of whether the password was right,
  wrong, or absent. A spec here could only assert that generic message,
  which would not actually validate password enforcement — worse than no
  spec, so this is skipped rather than faked.
- **Edit and export a multi-track project** — `editor-studio.tsx` operates
  on a processed recording's tracks; not reachable without `READY` media
  for the same reason as above.
- **Transcribe, correct, and search a recording** — transcription runs in a
  backend worker with no UI trigger. `recording-viewer.spec.ts` does assert
  the real "no transcript yet" empty state, but that is not transcribing,
  correcting, or searching anything.
- **Generate and accept AI chapters and summary** — AI artifact generation
  needs a configured provider and a transcript to ground it, neither
  reachable here. `recording-viewer.spec.ts` only asserts the panel and its
  action buttons render; it does not generate or accept anything.
- **Delete and recover according to policy** — `admin.spec.ts` covers
  setting the retention policy values; actual deletion and recovery
  execution happens in a backend sweep with no UI trigger to invoke it
  directly.
- **Record offline in the desktop app and resume upload** — `apps/desktop`
  is a native Tauri app (`apps/desktop/src-tauri/Cargo.toml` depends on the
  `tauri` crate and ships a `tauri.conf.json`/`build.rs`), not a web page;
  Playwright cannot drive it at all in this harness.

### What has actually been run

Three of the four `auth.spec.ts` cases have been run for real against a live
`next dev` server with a real (headless) Chromium and pass: the login form's
fields, the failed-login error message, and the unauthenticated-visitor
redirect away from the library. The fourth (full signup), and everything in
`library.spec.ts`, `recording-viewer.spec.ts`, `comments.spec.ts`, and
`admin.spec.ts`, need a reachable Postgres (and, for signup, nothing more
than that) to actually execute — run them with the full stack up per the
command above to get real coverage there. Until then, treat every claim
above as "verified by reading `apps/web` source, not by execution."
