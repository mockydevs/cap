# Object storage

Recordings are uploaded from the browser **directly to object storage** using
short-lived presigned requests; the web server never proxies the bytes. That is
deliberate — it is what keeps a video upload from occupying a web process — but
it has one consequence worth stating plainly:

> The bucket, not the application, decides whether an upload is allowed.

Server-side credentials can be perfectly correct and uploads will still fail if
the bucket does not permit the application's origin.

## Bucket CORS is required

A browser sends a preflight before each part upload. If the bucket has no
matching CORS rule, the preflight is rejected, `fetch` throws a bare
`TypeError`, and the person recording sees only "Failed to fetch". Nothing in
the server logs will mention it, because the request never reached the server.

Two parts are easy to get wrong:

- **`PUT` must be allowed**, not only `GET`/`HEAD`.
- **`ETag` must be in `ExposeHeaders`.** Without it the parts upload
  successfully and the multipart upload can never be completed, because the
  client cannot read the part identifiers it must send back.

The canonical rule lives in one place, `requiredCorsRule()` in `@cap/storage`,
and the Terraform module applies the same values. Print it for your deployment
with the verifier below.

## Verify before anyone records

```sh
pnpm --filter @cap/web storage:verify
```

It sends the same preflight a browser sends, reports precisely which part of
the rule is missing, and prints the configuration to apply. Run it after any
change to the bucket, the application origin, or the storage provider — and as
a post-deploy check, since this is a class of failure that is invisible until a
user finishes a recording.

Applying the rule:

- **Any S3-compatible provider** — `pnpm --filter @cap/web storage:apply-cors`
  writes it with the deployment's own credentials and re-verifies with a real
  preflight. Needs `s3:PutBucketCors`.
- **AWS S3, by hand** — `aws s3api put-bucket-cors --bucket <name> --cors-configuration file://infra/aws/bucket-cors.json`
- **Cloudflare R2** — dashboard, bucket, Settings, CORS policy
- **Terraform** — already configured for the bucket the module creates
  (`infra/aws/main.tf`). A bucket created outside the module has no rule.

## Choosing a provider

Storage itself is cheap; **egress is the cost that scales with usage**. On S3
that is roughly $0.09/GB of video served. On Cloudflare R2 it is zero, which
for a video product is the single largest lever on hosting cost.

`@cap/storage` is provider-neutral: set `AWS_S3_ENDPOINT` and the client
switches to path-style addressing and relaxes the CRC32 checksum behaviour that
R2, MinIO and Backblaze B2 reject. Nothing above the adapter changes.

**Recommended default: Cap-managed storage on R2.** It removes the egress bill
and keeps one bucket to configure correctly.

### Migrating to R2

Nothing in the application changes: playback signs `GET` requests against the
bucket directly (`presignPlayback`), so it behaves the same on either
provider. There is no CDN to reconfigure — the `AWS_CLOUDFRONT_*` settings
that used to be declared were never read by any code and have been removed.

1. Create the bucket in the Cloudflare dashboard, then an S3-compatible API
   token with object read/write on it.
2. Copy existing objects. Use `rclone`, which handles resume and parallelism:

   ```sh
   rclone copy s3-old:cap-recordings r2-new:cap-recordings --progress
   ```

3. Point the deployment at R2:

   ```sh
   AWS_REGION=auto
   AWS_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   AWS_S3_BUCKET_NAME=<bucket>
   AWS_ACCESS_KEY_ID=<r2 access key id>
   AWS_SECRET_ACCESS_KEY=<r2 secret>
   AWS_KMS_KEY_ARN=            # R2 has no KMS; must be empty
   ```

   `AWS_S3_ENDPOINT` also switches the client to path-style addressing and
   relaxes the CRC32 checksum behaviour R2 rejects.

4. Allow browser uploads: `pnpm --filter @cap/web storage:apply-cors`.
5. Prove nothing was left behind:
   `pnpm --filter @cap/web storage:check-objects`. It reads every object key
   the database references — sources, playback assets, caption tracks — and
   confirms each one exists in the new bucket. A copy tool can only report
   what it found; this reports what this deployment still needs.
6. Record something and watch it back before decommissioning the old bucket.

## Customer-owned buckets

Letting each workspace supply its own bucket is supported in principle by the
same adapter, but it is an enterprise option rather than the standard path, and
it is materially harder than customer-owned AI keys:

- **CORS becomes per-customer onboarding.** Every customer must apply the rule
  above to their own bucket, including the exposed `ETag`. A mistake surfaces
  as an unexplained upload failure at the end of their first recording.
- **Playback assumes one distribution.** Signed playback uses the deployment's
  CloudFront distribution. Serving a customer's bucket through it requires
  per-customer access grants and an origin access control each; the fallback is
  presigning every HLS segment, which gives up CDN caching.
- **Every worker needs the credential.** Media, transcription, render and
  retention all read and write. The credential envelope in `@cap/crypto`
  already supports this shape — it would take a new purpose alongside the AI
  and webhook ones.
- **Processing crosses regions.** Workers pulling a bucket in another region
  make media processing slower and put egress on the customer's bill.

If you do offer it, validate at connection time the way AI provider keys are
validated: apply the CORS rule with the customer's credentials, verify it with
a real preflight, and refuse to save a connection that would fail later. A
setup-time error with the fix attached is worth far more than a runtime
mystery.
