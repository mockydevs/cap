# Calendar attendance: Calari portal contract (proposal v1)

Status: ACCEPTED by root with constraints (`contract-response.md` in the
handoff task), paths `/api/v1/integrations/cap/calendar/resolve` and
`/api/v1/integrations/cap/calendar/pairing`. Portal side owned by the
`calari-cap-calendar` worker. Previously: PROPOSAL for root review. Cap side implemented on `codex/cap-calendar`;
no portal change made by Cap. Nothing here is enabled until both sides ship.

## Why

Calari accepts a delivery only for a `CapPairing` it created (`cap-receiver.ts`
checks pairing state, clientId, sourceKind, createdById). A server-side
calendar bot therefore needs Calari to (a) say which client an event belongs to,
within the staff member's own access, and (b) create the pairing as that staff
member. Calari keeps ownership/access; Cap never invents a client.

## Signing

Same HMAC scheme as `login`, new purpose label `calendar`:
`cap.v1.calendar\n{ts}\n{nonce}\n{body}` with the integration secret, headers
`x-cap-key-id`, `x-cap-timestamp`, `x-cap-nonce`, `x-cap-signature-256`.
Calari must reject replayed nonces and stale timestamps (±300 s) as for login.

New optional integration fields in Cap `CAP_MEETING_INTEGRATIONS`:
`calendar_resolve_url`, `calendar_pairing_url` (both https, set together).

## 1. POST calendar_resolve_url

Request (strict):
`{"user_id": "<calari user id>", "attendee_emails": ["a@x.com", ...]}`
(1–100 lowercase emails, exact, no display names/titles).
Response 200 (strict):
`{"tenant_id":"<uuid>","user_id":"...","active":true,
  "mappings":[{"email":"a@x.com","client_id":"<uuid>","client_display_name":"Acme"}]}`
Rules: only admin-confirmed client contact mappings (portal UI with audit), only clients the staff member may
access (tasks:assign as today), non-archived. Domains never match. Inactive or
unknown staff → `active:false`, empty mappings. Cap selects a client only if all
mapped attendees resolve to exactly one client; otherwise "needs review".

## 2. POST calendar_pairing_url

Request (strict):
`{"request_id":"<uuid, stable per attendance+version>","user_id":"...",
  "pairing_kind":"staff_client"|"internal_team","client_id":"<uuid>|null",
  "title":"<=200 chars","starts_at":"RFC3339","ends_at":"RFC3339"}`
`staff_client` requires a client; `internal_team` (only after an explicit
staff choice in Cap) requires null. A missing client never means internal.
Cap sends it at `start − (join lead + 5 min)`; portal rules: ends > starts,
≤ 12 h, starts ≤ now + 30 min; same request id + different body → 409.
Calari: re-checks staff active + client access (same as resolve), creates a
`CapPairing` with createdById=user_id, sourceKind = client_id ? `staff_client`
: `internal_team`, acceptUntil = ends_at + 36h, then calls Cap
`POST /v1/pairings` exactly as today (ttl_seconds 600) and returns:
`{"pairing_id":"...","code":"XXXX-XXXX","expires_at":"RFC3339"}`.
Idempotent on request_id (same body → same pairing; different body → 409).
Refusal → 403 `{"error":"forbidden"}` (Cap marks the attendance needs_review).

## 3. Delivery change (additive enum value)

`meeting.source` gains `"calendar_bot"` (in addition to desktop/extension).
`meeting.provider_hint` = `"google_meet"`, `meeting.meeting_url` =
`https://meet.google.com/<code>`. Everything else unchanged; authority still
comes from the stored pairing.

## Calari UI (optional, later)

Nothing required: staff connect calendars in Cap (`/calendar`) after signing in
with Calari. Recordings arrive as normal client/internal meetings created by
that staff member.
