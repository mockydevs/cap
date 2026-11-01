# Cap ↔ Calari meeting integration contract (v1.1)

Status: **v1.1, agreed in principle with Calari (Codex), receiver pending**. Calari owns the receiver, role checks, meeting
processing and portal UI. Cap owns capture, the meeting service, transcription
and delivery. Nothing here is live until both sides agree and deploy.

Machine-readable types live in `crates/meeting-protocol`; the example payloads in
`fixtures/` are generated from those types and checked by its tests, so the doc,
fixtures and code cannot drift apart silently.

## Parties and trust

| Party                          | Holds                                                                                                                              | Can do                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Calari server                  | integration key (`key_id` + exactly 32 secret bytes, provisioned as base64url without padding; the decoded bytes are the HMAC key) | create pairings for its own tenant; receive deliveries                           |
| Cap meeting service            | the same key, plus AI provider keys in its own env                                                                                 | issue device tokens, store audio, transcribe, summarize, deliver                 |
| Desktop app / Chrome extension | a short-lived **device token** for one client                                                                                      | create meetings for that one client, upload its audio, finalize it. Nothing else |

- The tenant is bound to the `key_id`. A body that names a different tenant is
  rejected (`403 tenant_mismatch`).
- An intake PIN or pairing code only ever leads to a device token with
  `meeting:create` + `meeting:upload` for one `client_id`. It never grants portal
  or admin access on either side.
- AI provider keys never leave the Cap service. They are not sent to the
  desktop app, the extension, logs, URLs or Calari.

## Request signing (both directions)

Every server-to-server request carries (each retry uses a fresh nonce):

| Header                 | Value                                                         |
| ---------------------- | ------------------------------------------------------------- |
| `x-cap-key-id`         | integration key id, e.g. `calari-prod-1`                      |
| `x-cap-timestamp`      | Unix seconds                                                  |
| `x-cap-nonce`          | 16–64 chars `[A-Za-z0-9_-]`, unique per request               |
| `x-cap-signature-256`  | `sha256=` + lowercase hex HMAC-SHA256 over the signing string |
| `x-cap-content-sha256` | lowercase hex SHA-256 of the entire raw body (deliveries)     |

Signing string (bytes, `\n` = 0x0A):

```
cap.v1.<purpose>\n<timestamp>\n<nonce>\n<raw request body>
```

`purpose` is `pairing` for Calari → Cap pairing requests and `delivery` for
Cap → Calari deliveries. The purpose prefix stops a captured request for one
endpoint being replayed against the other.

The Rust signer is tested against Calari's cross-language vector
(`docs/cap-signing-vector.json` in the Calari repo) and produces the same
signature. Receivers must: compare in constant time; reject `|now - timestamp| > 300 s`;
reject a `(key_id, nonce)` seen in the last 15 minutes; verify against the raw
bytes before parsing JSON.

## 1. Pairing (Calari → Cap)

Calari's server issues a pairing after it has authorized the person asking:
the `/intake` success receipt for that new client (`client_intake`), a staff
member on an existing client's page (`staff_client`), or a staff member with
`tasks:assign` for an internal meeting with no client (`internal_team`).

`POST {CAP_SERVER_URL}/v1/pairings` (signed, purpose `pairing`). Body: see
[`fixtures/pairing.request.json`](fixtures/pairing.request.json).

| Field                 | Rule                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| `request_id`          | UUID, stable across retries of one logical request                                   |
| `tenant_id`           | must equal the tenant bound to `x-cap-key-id`                                        |
| `pairing_kind`        | `client_intake` \| `staff_client` \| `internal_team`                                 |
| `client_id`           | UUID from Calari's own record. Required for client kinds, absent for `internal_team` |
| `intake_receipt_id`   | UUID, required for `client_intake`                                                   |
| `client_display_name` | optional, shown on the device after pairing                                          |
| `ttl_seconds`         | 60–900                                                                               |

Response `201` ([`fixtures/pairing.response.json`](fixtures/pairing.response.json)):
`pairing_id`, `code` (`XXXX-XXXX`, 8 Crockford base32 characters), `expires_at`,
`deep_link` (`cap://pair?code=…`, optional convenience; the extension uses the
same code typed by hand).

Retry safety: the code is derived from `HMAC(secret, request_id)`, so replaying
the same `request_id` with the same body (fresh nonce) returns `200` with the
same pairing and code while it is unexpired and unredeemed. The same
`request_id` with a different body is `409 request_conflict`; it can never return
another client's pairing. Cap stores only the code's SHA-256.

## 2. Redeeming a code (desktop/extension → Cap)

`POST /v1/pairings/redeem` `{"code": "7KQ2-M9XD", "device_name": "Clare's laptop", "device_kind": "desktop"}`

Returns `200` with `device_token` (opaque, shown once, stored as SHA-256),
`tenant_id`, `pairing_kind`, `client_id` (null for internal meetings),
`client_display_name`, `expires_at` (12 h) and
`scopes: ["meeting:create", "meeting:upload"]`. Wrong, expired or used codes all
return the same `404 pairing_invalid`, so the response does not reveal which.
Failed attempts are rate limited per source address and globally (`429`).

## 3. Meetings (device token, `Authorization: Bearer …`)

| Method + path                        | Purpose                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `POST /v1/meetings`                  | create; idempotent on `idempotency_key` per token                                              |
| `PUT /v1/meetings/{id}/chunks/{seq}` | upload one standalone audio chunk; `x-chunk-sha256`, `x-chunk-start-ms`, `x-chunk-duration-ms` |
| `POST /v1/meetings/{id}/events`      | lifecycle audit: idle warning, keep-recording, signal                                          |
| `POST /v1/meetings/{id}/finalize`    | `{last_seq, stop_reason, ended_at}`; `409` lists missing chunks to resend                      |
| `GET /v1/meetings/{id}`              | status, missing chunks, delivery receipt                                                       |

`POST /v1/meetings` takes `capture_mode`: `audio` (default) or `video`. Both are
transcribed; video also keeps the picture in Cap's private storage.

A token only sees meetings it created. Re-uploading a chunk with the same hash
is a no-op `200`; a different hash for the same `seq` is `409`. Chunks must be
WebM, Ogg, WAV or FLAC (checked by magic bytes), at most 8 MiB for audio and
48 MiB for video. Every chunk must be independently decodable (the extension
restarts its recorder per chunk; the desktop app uses FFmpeg's segment muxer).
`finalize` with `allow_missing: true` accepts gaps and marks the delivery
`partial`. A meeting left `recording` with no upload for 6 hours is finalized
by the server as `interrupted` with the audio it has.

## 4. Delivery (Cap → Calari)

`POST {CALARI_MEETING_DELIVERY_URL}` (signed, purpose `delivery`), plus
`x-cap-delivery-id: <event_id>`. Body: see
[`fixtures/delivery.meeting.transcript.completed.json`](fixtures/delivery.meeting.transcript.completed.json).

Key rules for the Calari receiver:

- `event_id` (UUID) is stable for a meeting + `revision`. Cap freezes the body
  bytes the first time it builds a delivery and re-sends exactly those bytes
  on every retry, so `x-cap-content-sha256` is stable. Same `event_id` and same
  content hash → `200 {"status":"duplicate"}`. Same `event_id`, different hash →
  `409`.
- Accept only if `pairing_id` is one Calari issued to the signing tenant and
  `client_id`/`intake_receipt_id`/`context.pairing_kind` equal what Calari
  stored for it. Otherwise `403`, do not store.
- `summary` is `null` by default: Calari's own worker summarizes and extracts
  actions once, so the transcript is not paid for twice.
- `context` carries only facts Cap knows (`pairing_kind`, `capture_mode`).
  Classifying the meeting (client meeting, internal briefing, task delegation)
  and extracting tasks with owners is Calari's job, from the transcript and
  `pairing_kind`.
- `transcript.segments` are complete and ordered by `index` / `start_ms`.
- Reply `2xx` with `{"receipt_id": "…", "status": "accepted" | "duplicate"}`.

Cap retries timeouts, `408`, `429` and `5xx` with exponential backoff (up to 8
attempts over about an hour) and records every attempt. Other `4xx` mark the
delivery `failed` for an operator to look at; it is never silently dropped.

## Stop reasons

`user_stopped`, `meeting_ended`, `tab_closed`, `window_closed`, `device_lost`,
`prolonged_inactivity`, `hard_limit`, `interrupted` (crash/power loss; partial
audio is still finalized and delivered with this reason).

## Agreed facts

- Delivery URL: `https://calarisolutions.com/api/portal/integrations/cap/meetings`.
- Pairing codes appear on the authorized `/intake` success receipt and on the
  staff client page; the public intake PIN is never sent to Cap.
- Calari has an Anthropic key and no audio-transcription key. Claude analyses
  text and images but does not take raw audio, so Cap transcribes on its own
  server (Whisper running in the Rust server, CPU-bound and size-limited) and
  sends text.
