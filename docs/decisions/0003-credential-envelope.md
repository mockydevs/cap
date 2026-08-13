# ADR 0003: One credential envelope, with or without KMS

- Status: Accepted
- Date: 2026-08-13
- Relates to: [ADR 0002](0002-provider-neutral-object-storage.md)

## Context

Cap stores two kinds of workspace secret that are written by the web app and read
by a worker in a different process: AI provider API keys and webhook signing
secrets. Both were sealed with AWS KMS, and the sealing logic existed in five
places — a generic envelope module and a webhook-specific copy in the web app,
inline `DecryptCommand` calls in the AI worker and the webhook worker, and a
separate copy of the encryption context in each.

Two problems followed from that. Every copy restated the KMS `EncryptionContext`
(`application`, `workspaceId`, `purpose`) by hand, and KMS refuses to decrypt on
any mismatch — so a one-word edit in one copy would have made stored credentials
permanently unreadable, with no test covering the pairing. And requiring KMS made
both features unavailable to anyone self-hosting without an AWS account, which
after the AGPL release is most prospective users.

## Decision

- `@cap/crypto` owns the envelope: the binding context, the supported schemes,
  the key reference format, and the secret fingerprint. Nothing else constructs
  an encryption context or calls KMS for credentials.
- Two schemes are supported per purpose, chosen by configuration:
  - AWS KMS, via `AI_CREDENTIALS_KMS_KEY_ARN` / `WEBHOOK_SECRETS_KMS_KEY_ARN`.
  - Local AES-256-GCM, via `AI_CREDENTIALS_LOCAL_KEY` /
    `WEBHOOK_SECRETS_LOCAL_KEY` (32 bytes, base64).
    KMS takes precedence where both are configured.
- Purposes keep separate keys and separate binding. The same context value is
  used as the KMS `EncryptionContext` and as the AES-GCM additional
  authenticated data, so under either scheme a ciphertext is bound to one
  workspace and one purpose.
- Each ciphertext is stored with a **key reference**: a KMS ARN, or
  `local:aes-256-gcm:<key id>`. The reader picks the scheme from that reference,
  which is what lets an existing deployment keep reading KMS-sealed rows after
  adding a local key, and lets a self-hosted deployment migrate to KMS later.
  A local reference whose key id does not match the configured key is refused
  rather than attempted.

## Consequences

Self-hosting needs no AWS account for AI or webhooks. The security properties
under KMS are unchanged, and the properties under a local key are now tested
directly: round-trip, cross-workspace refusal, cross-purpose refusal, tamper
detection, and key-mismatch refusal.

A local key is weaker than KMS in the ways that matter to a threat model where
the host is compromised: it sits in the process environment, there is no external
audit trail of decrypt calls, and no per-decrypt authorization. Operators who
need those properties should keep using KMS. Losing a local key makes every
credential sealed under it unreadable, so it belongs in a backup; rotation means
re-entering the affected credentials.

The database columns are still named `credential_key_arn` and `secret_key_arn`
though they now hold a key reference that is not always an ARN. Renaming them is
a migration with no behavioural benefit, so it is deliberately deferred rather
than bundled into this change.
