# Workspace AI provider connections

Cap supports workspace-owned BYOK connections for OpenAI, Anthropic Claude, and HTTPS OpenAI-compatible services. Owners and administrators create and route connections; members may run approved features without seeing the underlying credential.

## Security and lifecycle

The API validates a credential against the provider before saving it. It sends the secret to AWS KMS `Encrypt` with a workspace-bound encryption context and stores only the ciphertext, KMS key ARN, and a 12-character SHA-256 fingerprint. Read APIs never return ciphertext or plaintext. The AI worker loads an active connection for the job, calls KMS `Decrypt` with the same context immediately before use, and does not persist or log the plaintext.

Revocation overwrites the stored ciphertext and prevents queued jobs from resolving the connection. Provider routes and model allowlists are workspace-scoped. Each AI job records its selected connection, model, usage, estimated cost, prompt version, transcript revision, and hashed provider request identifier.

Configure `AI_CREDENTIALS_KMS_KEY_ARN` for web and AI worker. The Terraform module exposes a dedicated credentials key plus distinct web-encrypt and worker-decrypt IAM policies. Do not reuse the media key or grant the web service decrypt permission.

## Current routing

The settings screen supports workspace BYOK routing for transcript analysis, including summaries, titles, chapters, action items, highlights, grounded Q&A, translations, follow-ups, and sensitive-data suggestions. External-processing consent and workspace token/cost ceilings remain mandatory.

Transcription and embeddings retain their existing deployment-managed provider paths for now. Their contracts are separate because audio transcription, chat generation, and vector embeddings have different request formats, data residency, model capabilities, and cost semantics. Provider-connection capability fields and routing purposes are already modeled so those adapters can be added without exposing credentials or changing job provenance.

`AI_ALLOW_DEPLOYMENT_CREDENTIAL=true` explicitly enables the legacy deployment-wide `AI_API_KEY` fallback. It defaults to false; production workspaces should configure an approved connection instead.

## Translated captions

A `TRANSLATION` job returns both a flowing translated summary and a per-segment breakdown aligned to the source transcript's timestamps. Once that job is accepted, `GET /api/recordings/:recordingId/captions?language=<code>&format=vtt|srt` serves a generated caption file in that language — generated once and cached in object storage (keyed by transcript revision, so a re-transcription invalidates it automatically) rather than re-translated on every request.
