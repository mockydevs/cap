# Chrome Web Store preparation (2026-11-02)

Branch `codex/cap-webstore` from main 4350356 (extension = reviewed 4753ce8, formatted).
Local only: no upload, no production request, no real account. Chromium checks used a
fresh throwaway profile, Playwright Chromium 156.0.8078.4, fake capture devices.

## Microphone trace (user test: Cap meeting b1fbedd8, Calari d86bb422, transcript "you\nyou")

- `real-chromium-mic-before-fix.txt` (`repro.mjs`, package 4753ce8): the offscreen
  recorder cannot ask for the microphone. Without a prior grant `getUserMedia` fails at
  once with `NotAllowedError: Permission dismissed`. The 4753ce8 code then records the
  tab only and shows just a desktop notification, so a solo test call has near-silent
  audio (Whisper's typical "you" on silence) and Calari answers CAP_TRANSCRIPT_TOO_SHORT.
  The production audio was not read; that this is what happened in the user test is
  consistent but not proven.
- Same file: after the extension origin is granted (DevTools `Browser.grantPermissions`,
  standing in for a real Allow click), the **already open** offscreen page is still
  refused; a new offscreen page is allowed. The extension never closed that page, so a
  grant during a session did not help until Chrome restarted.
- Fix: Start checks the microphone in the offscreen page before creating a meeting,
  retries once in a new offscreen page, and otherwise refuses with a message pointing to
  Options; the recorder itself fails (releasing the tab) instead of falling back to tab
  only. `real-chromium-mic-after-fix.txt` (`after-fix.mjs`): both the keyed build and the
  store build give refused / refused-in-old-page / allowed-in-new-page, which is what the
  retry relies on.

## Tests

- `baseline-4350356.log`: 21/21 before changes. `tests-after.log`: 26/26 after.
- New: `test/microphone.test.mjs` (offscreen refuses tab-only fallback; mic-check), three
  background tests (no meeting created when refused; stale page replaced; mic off skips).
- `mutation-checks.log`: restoring the tab-only fallback, removing the pre-start check, or
  removing the retry each fails the new tests.
- `prettier --check .` (3.9.6) passes.

## Portal client choice (read-only)

Calari `portal/recorder/connect` (origin/main 0aa8252): the "Meeting for" SelectField is
`required` with an empty default, so nothing is pre-selected; "Internal team - no client"
submits `clientId: null`. Opening the list highlights that first option, so Enter twice
picks it. "Signed in as <name>" shows the login identity, which matches the reported
"anita@calarisolutions.com" answer. No client-binding bug was demonstrated; no change made.

## Store build

`STORE=1 apps/extension/build.sh` (`build-store.log`). Hash in the task result. Every
packaged file equals source except built `src/detector.wasm` (sha256 prefix
3f72d3de6272d899, same as the reviewed build) and `manifest.json` (source minus `key`).
Screenshots: `docs/chrome-web-store/screenshots/` from `shots.mjs` (synthetic local data).
