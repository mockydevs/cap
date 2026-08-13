# ADR 0002: Provider-neutral object storage

- Status: Accepted
- Date: 2026-08-13
- Amends: [ADR 0001](0001-aws-media-storage.md)

## Context

ADR 0001 fixed Cap to one AWS S3 bucket with a customer-managed KMS key, and
deliberately allowed a custom endpoint only for contract tests. Two things have
changed since.

Cap is now released under the AGPL for anyone to self-host. A self-hoster who
must first create an AWS account, a KMS key, and five IAM identities will not
get as far as recording anything, and the requirement is not one the software
actually needs: SSE-KMS is a property of one provider, not of Cap's upload
protocol.

Egress is also the dominant marginal cost of hosting video. AWS S3 charges about
$0.09/GB; Cloudflare R2 charges nothing for egress and roughly $0.015/GB-month
for storage. For a product whose share links are the core loop, keeping media on
a zero-egress store is the difference between a bounded and an unbounded bill.

## Decision

- Cap targets any S3-compatible object store. AWS S3, Cloudflare R2, MinIO, and
  Backblaze B2 are all supported configurations; AWS S3 remains what the hosted
  deployment uses today.
- `AWS_S3_ENDPOINT` is a supported production setting, not a test-only one.
  Setting it selects path-style addressing.
- `AWS_KMS_KEY_ARN` is optional. When it is set, every object Cap writes is
  encrypted under that key and reads assert that the stored object carries it —
  the ADR 0001 posture, unchanged. When it is unset, Cap relies on the store's
  own encryption at rest and asserts nothing about per-object keys.
- All processes build their S3 client through `createStorageClient()` in
  `@cap/storage`. Provider quirks belong there and nowhere else. In particular
  it sets `requestChecksumCalculation: "WHEN_REQUIRED"` whenever a custom
  endpoint is configured, because aws-sdk v3 otherwise attaches a CRC32 header
  that R2, MinIO, and B2 reject.
- Cap keeps signing every upload part with a SHA-256 digest regardless of
  provider. Upload integrity does not depend on the storage vendor.

## Consequences

Self-hosting needs a bucket and credentials, and nothing else. The hosted
deployment can move media to R2 by setting two environment variables, which
removes per-view egress cost without touching application code.

The trade is that "encrypted under a key we control, verified on read" is no
longer a property of every deployment, only of deployments that configure a KMS
key. Anyone running Cap on a store without KMS should confirm the provider's
encryption-at-rest posture themselves. Operators who need the ADR 0001
guarantees keep them by keeping `AWS_KMS_KEY_ARN` set.

The SHA-256 multipart checksum is verified against AWS S3 and LocalStack in CI.
It is expected to work on other S3-compatible stores but has not been exercised
against R2 or B2 in this repository; the first deployment on either should watch
for `CreateMultipartUpload` or `UploadPart` rejections and report them.
