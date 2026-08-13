# Workspace AI provider connections

Cap supports workspace-owned BYOK connections for OpenAI, Anthropic Claude, and HTTPS OpenAI-compatible services. Owners and administrators create and route connections; members may run approved features without seeing the underlying credential.

## Security and lifecycle

The API validates a credential against the provider before saving it, then seals
it with the envelope in `@cap/crypto` and stores only the ciphertext, the key
reference, and a 12-character SHA-256 fingerprint. Read APIs never return
ciphertext or plaintext. The AI worker loads an active connection for the job,
unseals it immediately before use, and does not persist or log the plaintext.
Every ciphertext is bound to one workspace and to the AI purpose, so a
credential cannot be read from another workspace or reused for webhook signing.

Custom provider URLs must resolve only to public addresses and outbound
requests do not follow redirects. For an intentionally private self-hosted
provider, the operator must add its exact hostname to
`OUTBOUND_PRIVATE_HOST_ALLOWLIST` in the web, AI-worker, and transcription-worker
environments. This is an operator control, not a workspace setting.

Revocation overwrites the stored ciphertext and prevents queued jobs from resolving the connection. Provider routes and model allowlists are workspace-scoped. Each AI job records its selected connection, model, usage, estimated cost, prompt version, transcript revision, and hashed provider request identifier.

## Configuring the key

Set one of these for both the web app and the AI worker:

| Variable                     | Scheme                                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_CREDENTIALS_KMS_KEY_ARN` | AWS KMS. The Terraform module exposes a dedicated credentials key and per-service policies against it: the web app encrypts (to store a key) and decrypts (to embed on the workspace's own credential), and the AI and transcription workers decrypt. Do not reuse the media key. |
| `AI_CREDENTIALS_LOCAL_KEY`   | 32 bytes, base64. AES-256-GCM in-process, for deployments without AWS. Generate with `openssl rand -base64 32`.                                                                                                                                                                   |

KMS wins if both are set. A local key is the simpler choice when self-hosting,
with the trade-off that it lives in the deployment's environment rather than in a
hardware-backed key service: back it up, because losing it makes every stored
provider credential unreadable, and treat rotation as re-entering each key. Cap
records which key sealed each credential and refuses to guess when the
configured key does not match.

## Who pays for a unit of AI work

Cap runs three AI purposes — `TRANSCRIPTION`, `ANALYSIS`, and `EMBEDDINGS` —
and one resolver decides, per workspace and per purpose, whose credential
performs the work. The rule lives once in `@cap/ai` as a pure function; the web
app and both workers load the same facts and call it, so a request the web app
authorizes cannot be judged differently by the process that performs it.

Resolution order, after the workspace policy, external-processing consent and
monthly ceiling have all passed:

| Lane         | When it applies                                               | Who is billed                           |
| ------------ | ------------------------------------------------------------- | --------------------------------------- |
| `BYOK`       | The workspace has an active connection routed for the purpose | The workspace, by its own provider      |
| `MANAGED`    | No routed key, but an active Cap plan with credit left        | The workspace, by the deployment's plan |
| `DEPLOYMENT` | Neither, and `AI_ALLOW_DEPLOYMENT_CREDENTIAL=true`            | The operator                            |
| `NONE`       | Neither, and the flag is false                                | Nobody — the feature is refused         |

A workspace on the managed lane whose credit is spent is refused rather than
handed the deployment credential: the ceiling it paid for is the point of the
lane. `AI_ALLOW_DEPLOYMENT_CREDENTIAL` defaults to false and is the only switch
that makes the operator pay for a workspace's AI.

### Transcription

Transcription is resolved per job, before the recording is downloaded or its
audio extracted, so an unentitled workspace costs neither provider spend nor
compute. A recording whose workspace has no way to pay gets its transcript
marked `DISABLED`; the UI turns that into a prompt to connect a key or start a
plan, and a later recording — or the same one re-requested once a credential
exists — transcribes normally.

Because every recording is transcribed, this is the largest AI cost on the
platform. Requiring a customer-held OpenAI key is real friction; a workspace
that would rather not hold one can point an `OPENAI_COMPATIBLE` connection at a
self-hosted or third-party endpoint, or take a plan where the deployment
offers them.

### Metering

`ai_usage_events` is the single record of metered consumption, written in the
same transaction that completes the job or run it belongs to and unique on
`(source_kind, source_id)` so a retry cannot double-count. Workspace ceilings
and the usage screen read that table and nothing else, which is what lets
analysis, transcription, and embedding spend be summed together.

Cost is estimated from a per-model rate table in `@cap/ai`, not from a single
blended rate: a workspace routed to a large Anthropic model and one routed to a
small OpenAI model must not read as the same spend.
`AI_INPUT_COST_MICROUNITS_PER_MILLION` and its output counterpart remain the
fallback for a model Cap publishes no rate for.

Selling plans is documented separately in [BILLING.md](./BILLING.md).

## Translated captions

A `TRANSLATION` job returns both a flowing translated summary and a per-segment breakdown aligned to the source transcript's timestamps. Once that job is accepted, `GET /api/recordings/:recordingId/captions?language=<code>&format=vtt|srt` serves a generated caption file in that language — generated once and cached in object storage (keyed by transcript revision, so a re-transcription invalidates it automatically) rather than re-translated on every request.
