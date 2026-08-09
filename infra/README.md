# Deployment notes

Coolify should deploy the `apps/web` Dockerfile in a separate staging and production environment. Postgres and Redis run on the private Coolify network; only the web service receives a public HTTPS domain.

## S3 setup

The production baseline is codified in `infra/aws`. Copy `terraform.tfvars.example` outside the repository, set an account-unique bucket name and exact HTTPS origins, then run `terraform init`, `terraform plan -var-file=...`, and `terraform apply -var-file=...` from an OIDC-authenticated deployment job. Keep state in a locked, encrypted remote backend configured by the operator; this repository deliberately does not prescribe or embed backend credentials.

Create one private bucket per environment, such as `cap-recordings-staging` and `cap-recordings-production`.

- Block all public access and use bucket-owner-enforced object ownership.
- Encrypt objects with a customer-managed KMS key and enable S3 Bucket Keys.
- Create lifecycle rules to abort incomplete multipart uploads and apply retention policies later.
- Give each web/worker service a distinct least-privilege IAM identity. Prefer short-lived workload credentials; use separately scoped, rotated access keys in Coolify only when workload roles are unavailable.
- Configure CORS only for the approved web origins and required `PUT`, `POST`, `GET`, `HEAD` methods when multipart upload is introduced.
- Expose the `ETag` response header; the browser must retain it to complete multipart uploads safely.

The application will persist object keys, never presigned URLs. Presigned URLs remain short-lived API responses.

CloudFront is disabled by default. To enable it, provide a public key and set `enable_cloudfront=true`; the distribution then requires signed URLs/cookies through its trusted key group and uses S3 Origin Access Control. Keep the matching private signing key in the web service secret store. Keep S3 private and do not log presigned URLs or signed-cookie values.

## Coolify environment variables

Set `NEXT_PUBLIC_APP_URL`, `AWS_REGION`, `AWS_S3_BUCKET_NAME`, `AWS_KMS_KEY_ARN`, `DATABASE_URL`, and `REDIS_URL`. Configure the optional provider and worker values shown in `.env.example`. Add AWS credentials via the Coolify secret store only if the running service has no AWS workload role. Never commit them or expose them as public variables.
