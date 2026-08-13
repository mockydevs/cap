# Browser extension

The Cap WebExtension provides one-click access to the authenticated recorder and recording library, a keyboard command, and page context-menu actions. It deliberately opens the main Cap web application for capture so browser permission prompts, workspace authorization, IndexedDB recovery, multipart checksums, and AWS signing remain in the audited application instead of being duplicated in privileged extension code.

Chrome and Edge use `manifest.chromium.json`; Firefox uses `manifest.firefox.json`. Run `bash apps/browser-extension/scripts/package.sh chromium` or `firefox` to produce installable ZIPs under `apps/browser-extension/dist`. A tag such as `extension-v0.1.0` validates both manifests, packages both variants, and attaches them to a public GitHub Release.

For local installation, extract the ZIP. Load the directory with Chrome/Edge “Load unpacked,” or use Firefox `about:debugging` → “Load Temporary Add-on” and select `manifest.json`. Store publication requires separate Chrome Web Store, Edge Add-ons, and Firefox Add-ons developer accounts and review.

Safari does not install WebExtension ZIPs directly. Apple requires `xcrun safari-web-extension-converter`, an Xcode container application, Apple signing, notarization, and App Store distribution. The shared source is suitable for conversion, but the Safari package must be produced on macOS with the organization's Apple credentials.

## Chromium: real in-browser recording

The Chromium build (Chrome, Edge) no longer just launches the web app — it records directly in the browser, Loom-style, and uploads to Cap through the same resumable-upload contract as `apps/web/components/capture-studio.tsx`. The Firefox build is unchanged and still only launches the web recorder/library.

- **Sign-in**: the popup requires signing in (email/password, or "Sign in with Google" via `chrome.identity.launchWebAuthFlow`) against the configured Cap server before recording is offered. There is no refresh/expiry mechanism; a 401 from any Cap API call during or after upload means the user must sign in again. The extension never round-trips login through the background service worker — the popup calls `src/lib/auth.js`/`src/lib/google-auth.js` directly, since login needs no background involvement.
- **Source types**: Current Tab (`chrome.tabCapture`), Full Screen / Window (`chrome.desktopCapture`), and Camera only (plain `getUserMedia`). Recording happens in an MV3 offscreen document (`src/offscreen.html`/`offscreen.js`), which is the only place `getUserMedia`/`MediaRecorder` can run without a visible tab.
- **Camera bubble**: when "Include camera" is checked alongside a screen/tab/window recording, a small always-visible-attempt popup window (`src/controls.html`/`controls.js`) captures and records the camera separately, then uploads it linked to the primary recording via `linkedRecordingId`, mirroring `capture-studio.tsx`'s dual-recorder pattern. For a camera-only recording, the camera is the primary capture (done in the offscreen document) and the controls window exists only for its Pause/Resume/Stop UI.
- **Resilience**: if a 401 arrives after an upload has already begun, the in-progress `PendingUpload` stays in IndexedDB (never deleted) so the popup's "Finish uploading" banner can resume it once the user signs in again.

### Manual pre-ship checklist

This feature was implemented without access to a real Chrome/Edge GUI (no browser automation available in this environment) — mirroring how an earlier, unrelated macOS ScreenCaptureKit change in this repo was handled: implemented best-effort against the documented APIs and unit-tested with mocked `chrome.*`/`MediaRecorder`/`getUserMedia`, but **none of the following has actually been exercised against a real browser**. Before shipping a Chromium build, manually verify:

- [ ] Load unpacked in both Chrome and Edge (`chrome://extensions` / `edge://extensions`, Developer mode, "Load unpacked", point at the extracted `cap-chromium-extension.zip`).
- [ ] Grant the runtime host permission (`optional_host_permissions`) against a real dev server origin via the popup's "Save and verify".
- [ ] Sign in via both email/password and Google. For Google, first register the locally-loaded extension's `https://<extension-id>.chromiumapp.org/` redirect URI in the Google Cloud Console project backing `GOOGLE_DESKTOP_OAUTH_CLIENT_ID` — the extension ID differs between an unpacked load and a Chrome Web Store publish, so this must be redone per environment.
- [ ] Record all four source types (Current Tab, Full Screen, Window, Camera only) end to end.
- [ ] Confirm a linked screen+camera recording lands as two correctly-associated recordings in the library.
- [ ] Force a 401 mid-recording (e.g. revoke the session server-side) and confirm the recording survives locally (IndexedDB `PendingUpload` intact) and resumes after re-login via the popup's banner.
- [ ] Kill the service worker mid-recording (`chrome://extensions` → the extension's "service worker" link → DevTools → close) and observe whether the offscreen document/recording survives — MV3 service worker lifecycle interaction with an active offscreen `MediaRecorder` is unverified.
- [ ] Confirm the Firefox package is behaviorally unchanged from before this feature (same files, same permissions, same UI).
- [ ] Confirm `pnpm --filter @cap/browser-extension test` and both `bash scripts/package.sh chromium`/`firefox` pass.

## Store publication and the desktop app's "Get it for..." buttons

Browsers deliberately block installing an extension from anywhere but their own store outside of developer mode — there's no supported way to make a downloaded zip "just install" with one click, and building a workaround (e.g. a desktop app silently writing OS-level browser policy to force-install) risks the _desktop app_ itself being flagged as unwanted software by Microsoft Defender or losing Apple notarization, since that's a known adware/PUP technique both platforms actively scan for. The only safe one-click path is real store publication:

- Submit the Chromium build to the [Chrome Web Store](https://chromewebstore.google.com/) and [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons) (same zip, two listings, two developer accounts, Chrome has a one-time $5 fee).
- Submit the Firefox build to [addons.mozilla.org](https://addons.mozilla.org/).
- Both require a privacy policy URL and a plain-language justification for the `tabCapture`/`desktopCapture`/`host_permissions` permissions during review.

Once published, update the placeholder URLs in `apps/desktop/src-tauri/src/lib.rs` (`CHROME_WEB_STORE_URL`, `EDGE_ADDONS_URL`, `FIREFOX_AMO_URL`) with the real listing URLs — the desktop app's "Browser extension" menu (`open_extension_store` command) falls back to the GitHub releases page until those are filled in, so the button always does something useful, but only becomes genuinely one-click after publication.
