# ADR 0001: AWS media storage and delivery

- Status: Accepted, amended by [ADR 0002](0002-provider-neutral-object-storage.md)
- Date: 2026-08-09

## Context

Cap requires direct resumable uploads, private media storage, asynchronous worker access, and authorized MP4/HLS playback. Deployment is managed by Coolify, while AWS is the chosen cloud provider.

## Decision

- Use one private AWS S3 bucket and customer-managed KMS key per environment.
- Enable S3 Block Public Access, bucket-owner-enforced object ownership, versioning, HTTPS-only access, SSE-KMS, and S3 Bucket Keys.
- Keep AWS SDK details behind `packages/storage`; domain code works with internal object-key and multipart-upload interfaces.
- The API creates, completes, and aborts multipart uploads. Clients only receive short-lived, operation-specific presigned requests after workspace authorization.
- Give web, media, render, transcription, and retention services separate least-privilege IAM identities. The AI worker receives approved text and has no bucket credentials.
- Serve MP4 and HLS assets with short-lived presigned GET requests. (The
  original CloudFront signed-cookie decision was never implemented and is
  superseded by ADR 0002's provider-neutral direct-bucket playback.)
- Use lifecycle rules to abort stale multipart uploads and expire temporary artifacts. Application retention rules control user media deletion and recovery windows.
- Use S3-compatible local infrastructure only for contract tests; production configuration does not set a custom endpoint or path-style addressing. (Superseded by ADR 0002: any S3-compatible store is a supported production target, and `AWS_KMS_KEY_ARN` is optional.)

## Consequences

On AWS this provides strong environment isolation and auditable access, but
requires KMS policy management, explicit IAM policies, and recovery drills.
Deleting a KMS key before all encrypted object versions expire would make media
unrecoverable, so key deletion must follow the longest retention window.
