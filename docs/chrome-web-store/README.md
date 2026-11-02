# Cap Meeting Recorder: Chrome Web Store submission pack

Status: **prepared, not uploaded**. Nothing here has been sent to Google. Upload, the
developer account, payment and legal acceptance are root/Don steps (see "Steps").

- Store ZIP: `STORE=1 apps/extension/build.sh` writes
  `target/extension/cap-extension-store_<version>.zip`. It is the normal build without the
  manifest `key`, packed with fixed timestamps and sorted entries (rebuilds are
  byte-identical). Hashes for the reviewed build are in the task `result.md` and
  `test-results/extension-webstore-2026-11-02/`.
- Version 0.2.0. Changes from the unpacked 0.1.0 (4753ce8): Google Calendar removed
  (code, `oauth2`, calendar host permission, content script); Start refuses when the
  microphone is requested but not allowed instead of silently recording the tab alone; the
  popup states what is recorded and where it is sent before Start.

## Steps (root/Don)

1. Developer account (Don): register with the chosen publisher Google account, accept the
   developer agreement, pay the one-time fee shown in the dashboard, set the publisher
   name, verify the contact email, and turn on 2-Step Verification (required to publish).
   The account email cannot be changed later.
2. Publish the privacy policy (from `privacy-policy-DRAFT.md`, after the unknowns are
   answered and it is approved) at a public HTTPS URL on the publisher's site.
3. Dashboard > Add new item > upload the store ZIP. **Do not submit yet.**
4. Package tab > note the Item ID and "View public key".
5. Calari: add `https://<ITEM_ID>.chromiumapp.org/calari` to the recorder redirect
   allowlist (production config, root only). Today only the unpacked ID
   `edoidpfmflnlhjkmaimdamkmokaphcba` is allowed, so sign-in from the Store build fails
   until this is done.
6. Optional, keeps one ID for local testing: put the Store public key (one line, no
   BEGIN/END lines) into `apps/extension/manifest.json` `key`, load unpacked, and confirm
   chrome://extensions shows the Item ID. The Store ID is assigned by the Store; the
   current dev key does **not** decide it.
7. Fill Listing, Privacy practices and Test instructions from the sections below; add the
   screenshots in `screenshots/` (1280x800 PNG). Choose "publish manually after review"
   (deferred publishing) so root can test the approved build first.
8. Before publishing: install the reviewed Store build in a clean Chrome profile and run
   the manual checks in "Reviewer and release checks" with a synthetic test account.

## Listing

- Name: Cap Meeting Recorder
- Summary (manifest, 108 chars): Record a meeting tab (audio or video) with a visible
  indicator and send the transcript to the Calari portal.
- Category: Workflow & Planning (or Communication; root decides). Language: English.
- Detailed description (draft):

  > Cap records a meeting you choose in Chrome and sends it to your organisation's Calari
  > portal, where it becomes a transcript, meeting notes and suggested tasks.
  >
  > How it works
  >
  > - Sign in with your Calari portal account on Calari's own page and choose the client
  >   (or an internal meeting) the recording belongs to. Your password is never entered
  >   in the extension.
  > - Open the meeting tab, click the Cap icon and choose Start. Chrome only lets Cap
  >   record after you click; it never starts on its own.
  > - Choose audio + transcript, or video + transcript. Allow your microphone in Options
  >   so your own voice is included; Cap will not start without it unless you turn it off.
  > - Recording shows in the toolbar badge. Cap stops when you click Stop, when a Google
  >   Meet call ends, when the tab closes, or after a long silence (with a warning first).
  > - Audio is kept in the browser until the server confirms it, so a dropped connection
  >   does not lose the meeting.
  >
  > Tell everyone in the meeting that it is being recorded, and follow your
  > organisation's and local rules on recording. Cap requires a Calari portal account with
  > permission to use the note taker.

  No ratings, user counts, awards or comparison claims. No keyword lists.

- Homepage / support URL: to be supplied by root (publisher site and a support contact).
- Assets: `screenshots/1-sign-in.png`, `2-ready.png`, `3-recording.png`, `4-options.png`
  (1280x800, real extension pages with synthetic data, popup shown enlarged on a plain
  background). Store icon: `src/icon.png` (128x128 PNG). It is a plain red circle;
  a branded icon (96x96 artwork, 16 px transparent padding) is recommended but is a brand
  decision. Promo tiles (440x280, 1400x560) are optional and not made.

## Privacy practices tab

- Single purpose: "Record a meeting tab the user chooses and send it to the user's
  Calari portal to produce a transcript, notes and tasks."
- Remote code: "No, I am not using remote code." All JavaScript is in the package.
  `src/detector.wasm` is built from this repository (`crates/meeting-detector-wasm`) by
  `build.sh`; it only decides silence/limit warnings from audio levels and makes no
  network calls.
- Permission justifications:
  - `tabCapture`: records the sound (and video, if chosen) of the tab the user starts Cap
    on, only after the user clicks Start or presses the shortcut.
  - `offscreen`: Manifest V3 service workers cannot use media APIs; a hidden offscreen
    page holds the recorder, the microphone and the audio mix for the recording.
  - `storage`: keeps the sign-in token and its expiry, the client name, the user's
    options and the state of a recording waiting to upload (audio itself is in
    IndexedDB until the server confirms it).
  - `alarms`: retries uploads every 5 minutes after a network failure or browser restart.
  - `notifications`: tells the user when recording stops and whether it was delivered,
    and warns before an automatic stop (silence or maximum length) with Keep/Stop buttons.
  - `tabs`: reads the recorded tab's title (meeting name) and URL to name the meeting,
    to detect leaving or returning to a meeting page, and to stop when that tab closes.
    Only the recorded tab is used; browsing history is not collected or sent.
  - `identity`: `launchWebAuthFlow` opens Calari's sign-in page and receives the one-time
    code at the extension's chromiumapp.org redirect (PKCE). No Google account access.
  - Host `https://meetings.calari.tech/*`: the Cap API that receives recordings.
  - Host `https://meet.google.com/*` (and the Meet content script): detects that a Google
    Meet call has ended so the recording stops; it reads only visible page text/buttons
    and sends only "call ended".
- Data usage (to tick; root confirms against the final policy): Personal communications
  (meeting audio/video and microphone), Authentication information (Calari device
  token), Website content (tab title and meeting URL of the recorded tab), Personally
  identifiable information only insofar as it is spoken or shown in a meeting. Not
  collected: health, financial, location, web history, user activity tracking.
  Certify: not sold, not used for unrelated purposes, not used for creditworthiness.
  The "humans do not read user data" rule needs care: recordings, transcripts and
  notes are shown to the user's own organisation in the Calari portal and Cap library
  by design. State that in the policy and description.
- Privacy policy URL: the published version of `privacy-policy-DRAFT.md`.

## Reviewer and release checks

Test instructions tab (only needed because the item requires an account):

- Create a dedicated **synthetic** reviewer account in Calari with only a synthetic
  client ("Review Test Client"), no real client records, and a short expiry. Never give
  reviewers Don's, Anita's or any staff account, and never real client data.
- Instructions text (draft): "Install, click the Cap icon > Sign in with Calari, sign in
  with the test account, choose Review Test Client. Open Options > Allow microphone.
  Open any tab playing sound (or https://meet.google.com), click the Cap icon > Start
  recording this tab; speak for 30 seconds; click Stop and send to Calari. The
  notification shows Sent to Calari."
- Root must create that account and decide where its recordings go and when they are
  deleted. This is a production write and needs Don's approval.

Manual checks root should run on the approved build before publishing (not run by
Claude; no real Chrome or production account was used):

1. Store build sign-in reaches the client picker and returns to the extension (proves the
   Store ID redirect is allowlisted).
2. Microphone not yet allowed + Start: popup shows the "Chrome has not allowed it"
   message and no meeting is created. Allow microphone in Options, Start again: records.
3. 1-minute synthetic call with speech on both sides; Calari transcript contains both.
4. Meet call end, tab close and Stop each stop and deliver.
