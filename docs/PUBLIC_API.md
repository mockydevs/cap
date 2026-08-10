# Public API

Cap exposes a small, read-only, versioned REST API under `/api/v1` for integrations that need to pull recording and transcript data — distinct from the cookie-authenticated routes the web app itself uses. Workspace owners and admins create keys at `/admin` (`POST /api/workspace/api-keys`); the key is shown once, at creation, and only its prefix is retrievable afterward.

## Authentication

Send the key as a bearer token:

```
Authorization: Bearer cap_live_...
```

Requests without a valid, unrevoked key return `401`. Each key is rate-limited to 300 requests per 5-minute window; exceeding it returns `429` with a `retry-after` header.

## Endpoints

- `GET /api/v1/recordings` — cursor-paginated list, scoped to the key's workspace
- `GET /api/v1/recordings/:recordingId` — recording detail
- `GET /api/v1/recordings/:recordingId/transcript` — cursor-paginated transcript segments

All endpoints are read-only in this version. Mutating actions (comments, sharing, deletion) go through push-based [webhooks](WEBHOOKS.md) or the authenticated app routes, not this API.

## Versioning

`/api/v1` is stable: fields are only ever added, never removed or repurposed. A breaking change would ship as `/api/v2` with `/api/v1` kept running until deprecation is announced.
