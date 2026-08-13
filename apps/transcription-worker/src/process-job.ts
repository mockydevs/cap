import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { KMSClient } from "@aws-sdk/client-kms";
import { createStorageClient } from "@cap/storage";
import type { Job } from "bullmq";
import type { Pool, PoolClient } from "pg";
import { transcriptionJobSchema, type TranscriptionJob } from "@cap/queue";
import {
  loadAiEntitlement,
  managedMarkupPercentFromEnvironment,
  recordAiUsage,
  type AiUsageLane,
} from "@cap/ai";
import { decryptCredential } from "@cap/crypto";
import {
  prepareProviderRunMerge,
  type ConsentBasis,
  type TranscriptionProvider,
  type TranscriptPersistence,
} from "@cap/transcription";
import { extractNormalizedAudio } from "./ffmpeg";
import { providerFromConnection, providerFromEnvironment } from "./provider";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
};

interface ResolvedTranscriptionProvider {
  readonly provider: TranscriptionProvider;
  readonly lane: AiUsageLane;
  readonly connectionId: string | null;
}

/**
 * Decides whose credential transcribes this recording.
 *
 * Every recording that finishes processing reaches this worker, which makes
 * transcription the platform's largest and least avoidable AI cost. It is
 * resolved per job — against the workspace's own routed key, its plan, or
 * (only when the operator has explicitly opted in) the deployment credential —
 * rather than from a single provider built once at start-up.
 */
export async function providerForJob(
  pool: Pool,
  kms: KMSClient,
  workspaceId: string,
): Promise<ResolvedTranscriptionProvider | null> {
  const entitlement = await loadAiEntitlement(pool, {
    workspaceId,
    purpose: "TRANSCRIPTION",
    deploymentCredentialAllowed:
      process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL === "true",
  });
  if (entitlement.lane === "NONE") return null;
  if (entitlement.lane !== "BYOK")
    return {
      provider: providerFromEnvironment(),
      lane: entitlement.lane,
      connectionId: null,
    };
  const selected = await pool.query<{
    base_url: string | null;
    encrypted_credential: string;
    credential_key_arn: string;
  }>(
    "SELECT base_url,encrypted_credential,credential_key_arn FROM ai_provider_connections WHERE id=$1 AND workspace_id=$2 AND status='ACTIVE'",
    [entitlement.connectionId, workspaceId],
  );
  const connection = selected.rows[0];
  if (!connection) return null;
  return {
    provider: providerFromConnection({
      baseUrl: connection.base_url,
      apiKey: await decryptCredential({
        workspaceId,
        purpose: "ai-provider-credential",
        ciphertext: connection.encrypted_credential,
        keyReference: connection.credential_key_arn,
        kms,
      }),
      model: entitlement.model,
    }),
    lane: "BYOK",
    connectionId: entitlement.connectionId,
  };
}

/**
 * Records that this workspace cannot be transcribed right now, without
 * touching a transcript another attempt is mid-way through. DISABLED is the
 * state the UI turns into "connect a key or start a plan"; a later recording,
 * or a re-request once a credential exists, moves it on.
 */
async function markUnavailable(pool: Pool, data: TranscriptionJob) {
  await pool.query(
    `WITH asset AS (
       SELECT id FROM recording_assets WHERE recording_id=$1 AND kind='MP4'
       ORDER BY processing_version DESC LIMIT 1
     )
     INSERT INTO transcripts (workspace_id,recording_id,source_asset_id,status)
     SELECT $2,$1,asset.id,'DISABLED' FROM asset
     ON CONFLICT (recording_id) DO UPDATE SET status='DISABLED',updated_at=now()
     WHERE transcripts.status <> 'PROCESSING'`,
    [data.recordingId, data.workspaceId],
  );
}

export async function processJob(
  pool: Pool,
  kms: KMSClient,
  persistence: TranscriptPersistence<PoolClient>,
  job: Job<TranscriptionJob>,
) {
  const data = transcriptionJobSchema.parse(job.data);
  // Resolved before any download or audio extraction: an unentitled workspace
  // must cost neither the operator's provider spend nor its compute.
  const resolved = await providerForJob(pool, kms, data.workspaceId);
  if (!resolved) {
    await markUnavailable(pool, data);
    return;
  }
  const { provider } = resolved;
  const target = await pool.query<{ transcript_id: string; attempt: number }>(
    "WITH asset AS (SELECT id FROM recording_assets WHERE recording_id=$1 AND kind='MP4' ORDER BY processing_version DESC LIMIT 1), created AS (INSERT INTO transcripts (workspace_id,recording_id,source_asset_id,status) SELECT $2,$1,asset.id,'PROCESSING' FROM asset ON CONFLICT (recording_id) DO UPDATE SET source_asset_id=EXCLUDED.source_asset_id,status='PROCESSING',updated_at=now() RETURNING id) SELECT created.id transcript_id, COALESCE((SELECT max(attempt)+1 FROM transcription_runs WHERE transcript_id=created.id),1)::int attempt FROM created",
    [data.recordingId, data.workspaceId],
  );
  const transcriptId = target.rows[0]?.transcript_id;
  const attempt = target.rows[0]?.attempt;
  if (!transcriptId || !attempt)
    throw new Error("Recording has no playback asset for transcription");
  const runId = randomUUID();
  const consentValue = required("TRANSCRIPTION_CONSENT_BASIS");
  if (!["EXPLICIT", "WORKSPACE_POLICY", "NOT_REQUIRED"].includes(consentValue))
    throw new Error("TRANSCRIPTION_CONSENT_BASIS is invalid");
  const consentBasis = consentValue as ConsentBasis;
  const consentActorUserId = process.env.TRANSCRIPTION_CONSENT_ACTOR_USER_ID;
  if (consentBasis === "EXPLICIT" && !consentActorUserId)
    throw new Error(
      "Explicit consent requires TRANSCRIPTION_CONSENT_ACTOR_USER_ID",
    );
  const consentCapturedAt = new Date();
  const workdir = await mkdtemp(join(tmpdir(), "cap-transcription-"));
  try {
    const sourcePath = join(workdir, "source");
    const audioPath = join(workdir, "audio.wav");
    const client = createStorageClient();
    const source = await client.send(
      new GetObjectCommand({
        Bucket: required("AWS_S3_BUCKET_NAME"),
        Key: data.sourceObjectKey,
      }),
    );
    if (
      !source.Body ||
      typeof (source.Body as NodeJS.ReadableStream).pipe !== "function"
    )
      throw new Error("S3 source is not readable");
    await pipeline(
      source.Body as NodeJS.ReadableStream,
      createWriteStream(sourcePath, { flags: "wx" }),
    );
    await extractNormalizedAudio(sourcePath, audioPath);
    const snapshot = await persistence.loadCanonical(transcriptId);
    const result = await provider.transcribe({
      jobId: job.id ?? `transcription:${data.recordingId}`,
      audio: createReadStream(audioPath),
      mediaType: "audio/wav",
      identifySpeakers: false,
      consentBasis,
    });
    await persistence.commitMergedProviderRun(
      prepareProviderRunMerge({
        snapshot,
        provenance: {
          runId,
          attempt,
          consentBasis,
          consentCapturedAt,
          ...(consentActorUserId ? { consentActorUserId } : {}),
        },
        result,
        ids: { segmentId: randomUUID, wordId: randomUUID },
      }),
      (transaction) =>
        recordAiUsage(transaction, {
          workspaceId: data.workspaceId,
          purpose: "TRANSCRIPTION",
          lane: resolved.lane,
          sourceKind: "TRANSCRIPTION_RUN",
          sourceId: runId,
          connectionId: resolved.connectionId,
          provider: result.provider,
          model: result.model,
          units: result.billedDurationMs ?? result.durationMs,
          unitKind: "AUDIO_MS",
          costMicrounits: result.costMicrounits ?? 0,
          ...(result.currency ? { currency: result.currency } : {}),
          markupPercent: managedMarkupPercentFromEnvironment(process.env),
        }),
    );
    if (resolved.connectionId)
      await pool.query(
        "UPDATE ai_provider_connections SET last_used_at=now() WHERE id=$1 AND workspace_id=$2",
        [resolved.connectionId, data.workspaceId],
      );
  } catch (error) {
    await pool.query(
      "INSERT INTO transcription_runs (id,transcript_id,attempt,status,provider,model,identify_speakers,consent_basis,consent_captured_at,consent_actor_user_id,error_category,started_at,completed_at) VALUES ($1,$2,$3,'FAILED',$4,$5,false,$6,$7,$8,$9,$7,now()) ON CONFLICT (transcript_id,attempt) DO NOTHING",
      [
        runId,
        transcriptId,
        attempt,
        provider.name,
        process.env.TRANSCRIPTION_MODEL ?? "unknown",
        consentBasis,
        consentCapturedAt,
        consentActorUserId ?? null,
        error instanceof Error ? error.name : "UnknownError",
      ],
    );
    await pool.query(
      "UPDATE transcripts SET status='FAILED',updated_at=now() WHERE id=$1 AND status<>'READY'",
      [transcriptId],
    );
    throw error;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
