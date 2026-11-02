# DRAFT: Cap Meeting Recorder privacy policy

> DRAFT for root/legal review. Not published. Items marked **[UNKNOWN]** must be answered
> by the operator before publication; do not publish with placeholders. This draft
> describes what the extension code does (version 0.2.0); server-side retention and
> processors are not visible from the extension and are listed as unknowns.

Last updated: [DATE]. Operator: **[UNKNOWN: legal name of the publisher/controller,
e.g. Calari Solutions or Mocky Digital], [address], [privacy contact email]**.

## What the extension does

Cap Meeting Recorder records a browser tab that you choose and sends the recording to
your organisation's Calari portal, where it is turned into a transcript, meeting notes
and suggested tasks. It records only after you click Start (or press the keyboard
shortcut) and shows a recording badge while it runs.

## What we collect

- **Meeting recording:** the sound of the chosen tab, and its video if you choose video,
  plus your microphone if "Record my microphone" is on (it is on by default; Cap will not
  start without microphone permission unless you turn it off). This can include the
  voices, names and anything said or shown by everyone in the meeting.
- **Meeting details:** the tab's title (used as the meeting name), the meeting link if
  the tab is on a known meeting site (Google Meet, Zoom, Teams, Webex, Whereby), capture
  mode, start and end times, and why the recording stopped.
- **Sign-in:** you sign in on Calari's own website; your password never passes through
  the extension. The extension receives and stores a device token for your chosen client
  or internal team, its expiry and the client's display name.
- **Google Meet page text:** on meet.google.com the extension checks the page for the
  "call ended" screen. The page text is not stored or sent; only the fact that the call
  ended is used to stop the recording.

We do not collect browsing history, keystrokes, location, contacts, payment or health
information, and we do not access your Google account.

## Where it is stored and sent

- **In your browser:** recording chunks are kept in the extension's IndexedDB until the
  Cap server confirms each one, then deleted. Chunks the server permanently refuses are
  kept, marked as quarantined, with no automatic expiry **[follow-up: add an expiry]**.
  Sign-in token, options and pending-upload state are kept in extension storage until
  you disconnect, the token expires, or you remove the extension.
- **Cap server (meetings.calari.tech):** receives the recording over HTTPS, creates the
  transcript and passes the meeting to the Calari portal. Hosting location and provider:
  **[UNKNOWN]**. Transcription: **[UNKNOWN: confirm it runs on the Cap server only,
  e.g. the self-hosted Whisper model, and no third-party speech API]**. Encryption at
  rest: **[UNKNOWN]**.
- **Calari portal (calarisolutions.com):** stores the transcript, summary and tasks for
  your organisation. AI or other processors used to create summaries and tasks:
  **[UNKNOWN: list every third party]**.

## Who can see it

Recordings, transcripts, notes and tasks are visible to authorised users of your
organisation's Calari portal and Cap meeting library (for example staff with a Cap
role), because reviewing meetings is the purpose of the service. Operator staff access
for support or security: **[UNKNOWN: state when, who, and with what consent]**.

We do not sell this data, use it for advertising, use it to determine creditworthiness,
or use it for any purpose other than providing the recording, transcription and notes
service. [The use and transfer of information received complies with the Chrome Web
Store User Data Policy, including the Limited Use requirements.]

## How long we keep it

Audio and video on the Cap server: **[UNKNOWN]**. Transcripts, notes and tasks in
Calari: **[UNKNOWN]**. Deletion on request and how to ask: **[UNKNOWN]**.

## Your choices

- Recording only happens when you start it; you can stop at any time.
- Turn off "Record my microphone" in Options to record only the meeting tab.
- "Disconnect from Calari client" in Options removes the sign-in token; recordings still
  waiting to upload keep their own token so they are not lost.
- Removing the extension deletes everything it stored in your browser.
- You are responsible for telling meeting participants that the meeting is recorded and
  for following the recording laws that apply to you.

## Contact

**[UNKNOWN: privacy contact email and address]**
