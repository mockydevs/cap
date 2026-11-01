# Deploy the Rust meeting service

This is an additive service. Keep the existing Cap web app, database, bucket and workers running. Full Rust replacement phases are separate releases. Do not expose PostgreSQL, Redis or S3 publicly.

## Prepare

Use the existing Coolify Cap Compose application and private `DATABASE_URL`/AWS credentials. Set the `cap-server` service domain to a dedicated HTTPS hostname, preserving the existing web domain. The Calari deployment uses `https://meetings.calari.tech`; verify DNS and the proxy before assigning it. Set `CAP_SERVER_PUBLIC_URL` to that service origin. Calari's API uses the same origin in `CAP_MEETING_SERVICE_URL` and `CAP_PUBLIC_URL`.

Provision an absolute host directory owned by the operator and readable by UID10001. Run `scripts/fetch-whisper-model.sh base.en /absolute/model-directory`, then set `CAP_WHISPER_MODEL_DIRECTORY` to that directory in Coolify. The service mounts it read-only. The script pins the official whisper.cpp Hugging Face repository revision and validates its LFS SHA-256 before an atomic replacement. Sources: [model repository](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1).

Start with `ggml-base.en`, two Whisper threads, one in-process transcriber, a 2-CPU limit and 2GiB memory limit on the shared 8-vCPU CPU-only host. These are bounded initial settings, not a throughput guarantee. Time a representative synthetic recording on the deployed image before increasing concurrency; preserve headroom for PostgreSQL and the other production apps. The tiny.en end-to-end fixture is a correctness check, not a base.en production benchmark.

Set `TRUSTED_PROXY_HOP_COUNT` to the verified number of proxies between the client and this container (normally one for direct Coolify Traefik). Do not increase it blindly: overcounting trusts caller-supplied forwarded addresses.

## Signed integration credentials

Create 32 random bytes in an operator script (`secrets.token_bytes(32)`), encode using URL-safe base64 without padding, and retain the value only in a mode0600 temporary credential file or approved secret store. Do not print the secret, paste it into chat, add it to shell command arguments/history or commit it. Use the same decoded bytes on both servers.

Set Coolify's secret `CAP_MEETING_INTEGRATIONS` to a JSON array with `key_id`, the exact Calari workspace UUID as `tenant_id`, `secret`, and `delivery_url` = `https://calarisolutions.com/api/portal/integrations/cap/meetings`. Save the matching key ID and secret through Calari's administrator-only Cap connection API (CSRF protected), or a trusted server-side setup script using its existing credential encryption keyring. Never put an AI provider key in this integration configuration. Calari alone summarizes and assigns tasks using its encrypted provider key.

Set these variables before deploying the new Compose service. Required values use Compose `:?` checks; production server validation rejects non-HTTPS URLs, missing integrations, filesystem audio storage and fake transcription. Leave the existing S3 bucket private; new objects use the `meetings/` prefix. Reuse `AWS_KMS_KEY_ARN` when configured and confirm `ServerSideEncryption` on a synthetic test object in the isolated test environment.

## Release gate and verification

1. Pass Rust fmt, clippy, PostgreSQL/FFmpeg integration tests, extension tests, Docker build, Calari checks and independent review. Windows/macOS compile checks do not prove hardware capture.
2. Test synthetic recording → real Whisper → signed Calari receipt → real analysis → correctly bound notes/tasks in an isolated workspace/database. Verify retries do not duplicate tasks and internal meetings never gain a client.
3. After the authorized release, apply only additive migrations, deploy and verify Docker health plus HTTPS `/healthz`. The image's `cap-server healthcheck` performs an HTTP check; do not replace it with shell `/dev/tcp`.
4. Verify Calari login, connection status, intake/client pairing and the core flow. Do not create live test clients or meeting records without explicit authorization. Record what was checked and any device-specific limits.
5. Keep prior images and schema/data intact for rollback. Stop the new meeting service or roll back its image if necessary; do not drop `meeting_*` tables, reset migration ledgers, or delete recordings/model volumes.

The Chrome extension needs an explicit user gesture for tab capture. Calendar OAuth needs its own real Chrome-extension client ID; an unconfigured placeholder is not a working Calendar connection. macOS meeting video/system audio and Windows/macOS hardware capture must not be described as verified until tested on those devices.
