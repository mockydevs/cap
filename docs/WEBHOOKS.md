# Webhooks

Workspace owners and admins register HTTPS endpoints at `/admin` (or via `POST /api/workspace/webhooks`) to receive server-to-server notifications for domain events. A dedicated `webhook-worker` service delivers them; the web application never blocks a request on an outbound webhook call.

## Events

- `recording.ready` — a recording finished processing and has playable assets
- `recording.deleted` — a recording was deleted (manually or by a retention policy)
- `transcript.ready` — a transcript finished processing and is ready to read
- `ai_artifact.created` — an AI job produced a new suggested artifact
- `comment.created` — a comment was added to a recording

Each endpoint subscribes to an explicit subset of these events.

## Delivery

A delivery is an HTTP `POST` with a JSON body:

```json
{
  "id": "<delivery id>",
  "event": "recording.ready",
  "createdAt": "<ISO 8601>",
  "data": { "...": "event-specific fields" }
}
```

Request headers:

- `x-cap-event`: the event name
- `x-cap-delivery-id`: a stable ID for this delivery attempt, safe to use for idempotency
- `x-cap-signature-256`: `sha256=<hex HMAC>` of the exact request body, keyed with the endpoint's signing secret

Verify a delivery by recomputing the HMAC-SHA256 of the raw request body with your signing secret and comparing it to `x-cap-signature-256` using a constant-time comparison. The signing secret is shown once, at creation time, and is never retrievable afterward — only its last-12-character fingerprint is stored for identification.

A delivery is retried with exponential backoff (up to 6 attempts over roughly 15 minutes) if the endpoint doesn't respond with a `2xx` status within 10 seconds. Deleting an endpoint stops future deliveries but does not cancel deliveries already in flight.

## Operating the delivery worker

The `webhook-worker` service polls a transactional outbox (`webhook_outbox`) written by the web app and the media/transcription/AI workers in the same database transaction as the underlying state change, so an event is never emitted for a change that didn't actually commit. It requires a key dedicated to webhook signing secrets, distinct from the media and AI-credential keys, so no other service can decrypt them: either `WEBHOOK_SECRETS_KMS_KEY_ARN` (AWS KMS) or `WEBHOOK_SECRETS_LOCAL_KEY` (32 bytes base64, from `openssl rand -base64 32`) for deployments without AWS. Both the web app and the worker need the same one. Secrets are sealed with the envelope in `@cap/crypto` and bound to the workspace and to the webhook purpose, so a signing secret cannot be unsealed as an AI credential or read from another workspace.
