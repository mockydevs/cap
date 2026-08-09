# Production operations

This runbook is the required deployment and recovery procedure for Cap. Staging and production must use separate PostgreSQL databases, Redis instances, S3 buckets, KMS keys, IAM principals, OAuth clients, and application secrets.

## Deploy with Coolify

1. Apply `infra/aws` from a trusted CI identity authenticated through GitHub OIDC. Review the Terraform plan before every apply.
2. Create private Coolify services for PostgreSQL and Redis. Enable persistent storage and provider-level encrypted backups.
3. Configure the web, media, render, transcription, and AI worker containers from this repository. Only the web service is public.
4. Put every value from `.env.example` in the Coolify secret store. Use a distinct least-privilege AWS identity for each container when workload identity is unavailable. Never reuse the web identity for a worker.
5. Run database migrations exactly once before deploying application containers: `pnpm --filter @cap/web db:migrate`.
6. Deploy workers, then web. Check `/api/health` on web and `/health` on every worker before shifting traffic.

The AI worker is optional. Leave workspace AI disabled unless its configured `AI_PROVIDER` matches the workspace policy. `openai-compatible` requires explicit external-processing consent; `self-hosted` is intended for an OpenAI-compatible private endpoint.

## Backup and restore

- Take encrypted PostgreSQL backups at least daily and retain 30 daily copies. Keep a second copy outside the Coolify host.
- Enable S3 versioning and retain non-current media versions for the configured recovery window. Do not delete the KMS key while any recoverable object version exists.
- Redis is disposable queue state; PostgreSQL rows and transactional outbox records are the source of truth.

Quarterly restore drill:

1. Create an isolated database and restore the latest backup with `pg_restore --clean --if-exists --no-owner`.
2. Point an isolated staging deployment at that database and the staging bucket. Never connect a restore drill to production workers.
3. Verify sign-in, workspace isolation, recording playback, transcript search, one export, and one AI job.
4. Record achieved recovery point and recovery time, migration version, and any missing objects. A backup is not accepted until this drill passes.

## Monitoring and alerts

Alert on web/worker health failures, queue age and failed-job growth, PostgreSQL storage/connections/replication lag, Redis memory/evictions, S3 4xx/5xx and incomplete multipart growth, KMS access denials, storage/egress growth, and monthly AI token/cost consumption. Logs must exclude authorization headers, cookies, OAuth codes, share tokens, presigned URLs, provider request IDs, transcript bodies, and object upload IDs.

## Incident response

1. Assign an incident lead and record the start time, affected environments, and symptoms.
2. Contain access: revoke the affected session, share link, OAuth client, IAM key, or provider key. Do not rotate the KMS key by deleting it.
3. Preserve CloudTrail, application, database, and Coolify deployment logs. Restrict access to the response team.
4. Roll back to the last known immutable image when a deployment caused the incident. Database rollback means restore/forward-fix, never destructive ad-hoc schema changes.
5. Reconcile queued jobs from PostgreSQL, verify S3 objects with `HeadObject`, and re-run idempotent processing only after containment.
6. Notify affected users when required, document root cause and scope, and add a regression test before closing the incident.

## Release gate

A production release requires all repository checks to pass, migrations tested against a recent restored snapshot, infrastructure plan reviewed, staging smoke tests completed, backup restore evidence current, and platform signing/notarization credentials available for desktop releases. Real browser/device and load testing remain environment activities and cannot be replaced by unit tests.
