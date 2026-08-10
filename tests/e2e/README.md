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

`specs/auth.spec.ts` covers the login/signup smoke path described in
ARCHITECTURE.md's testing strategy: the login form's fields, a failed-login
error message, redirecting an unauthenticated visitor away from the
library, and a full signup → authenticated session → sign-out round trip.

The remaining ARCHITECTURE.md-listed scenarios (record and upload, resume
an interrupted upload, process and play a recording, seek, unlisted/
password-protected links, timestamped comments, editor export, transcribe/
correct/search, AI chapters and summary, desktop offline recording, delete
and recover) still need specs — this establishes the harness and the first
real coverage, not the complete suite.

Three of the four `auth.spec.ts` cases have been run for real against a live
`next dev` server with a real (headless) Chromium and pass: the login form's
fields, the failed-login error message, and the unauthenticated-visitor
redirect away from the library. The fourth (full signup) needs a reachable
Postgres to get past the database insert — run it with the full stack up per
the command above to get real coverage there too.
