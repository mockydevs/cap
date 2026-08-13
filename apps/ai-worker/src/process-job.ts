import { createHash, randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import type { Pool, PoolClient } from "pg";
import type { KMSClient } from "@aws-sdk/client-kms";
import { aiJobSchema, type AiJob } from "@cap/queue";
import {
  loadAiEntitlement,
  managedMarkupPercentFromEnvironment,
  recordAiUsage,
  transcriptInputHash,
  type AiDenialReason,
  type AiUsageLane,
} from "@cap/ai";
import { decryptCredential } from "@cap/crypto";
import {
  providerFromConnection,
  providerFromEnvironment,
  type AiProvider,
} from "./provider";

/**
 * Raised when the workspace may not run this job — AI switched off, consent
 * withdrawn, ceiling reached, plan credit spent, or no credential routed.
 * Distinct from a transport failure because it must not be retried: nothing
 * about the job will change on a second attempt.
 */
export class AiEntitlementDenied extends Error {
  constructor(readonly reason: AiDenialReason) {
    super(reason);
    this.name = "AiEntitlementDenied";
  }
}

export interface ResolvedJobProvider {
  readonly provider: AiProvider;
  readonly lane: AiUsageLane;
  readonly connectionId: string | null;
}

/**
 * Decides whose credential performs this job, at the moment it runs.
 *
 * The entitlement is resolved fresh rather than trusting what the web app
 * pinned at enqueue: a key revoked, a plan cancelled, or a ceiling reached in
 * between must stop the job. The connection recorded on the job stays as
 * provenance of what was authorized; the row is updated on completion with
 * what actually ran.
 */
export async function providerForJob(
  pool: Pool,
  kms: KMSClient,
  data: AiJob,
): Promise<ResolvedJobProvider> {
  const entitlement = await loadAiEntitlement(pool, {
    workspaceId: data.workspaceId,
    purpose: "ANALYSIS",
    deploymentCredentialAllowed:
      process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL === "true",
  });
  if (entitlement.lane === "NONE")
    throw new AiEntitlementDenied(entitlement.reason);
  if (entitlement.lane !== "BYOK")
    return {
      provider: providerFromEnvironment(),
      lane: entitlement.lane,
      connectionId: null,
    };
  const selected = await pool.query<{
    provider: "OPENAI" | "ANTHROPIC" | "OPENAI_COMPATIBLE";
    base_url: string | null;
    encrypted_credential: string;
    credential_key_arn: string;
  }>(
    "SELECT provider,base_url,encrypted_credential,credential_key_arn FROM ai_provider_connections WHERE id=$1 AND workspace_id=$2 AND status='ACTIVE'",
    [entitlement.connectionId, data.workspaceId],
  );
  const connection = selected.rows[0];
  if (!connection) throw new AiEntitlementDenied("AI_PROVIDER_NOT_CONFIGURED");
  const apiKey = await decryptCredential({
    workspaceId: data.workspaceId,
    purpose: "ai-provider-credential",
    ciphertext: connection.encrypted_credential,
    keyReference: connection.credential_key_arn,
    kms,
  });
  return {
    provider: providerFromConnection({
      provider: connection.provider,
      baseUrl: connection.base_url,
      apiKey,
      model: entitlement.model,
    }),
    lane: "BYOK",
    connectionId: entitlement.connectionId,
  };
}

async function markDenied(pool: Pool, data: AiJob, reason: AiDenialReason) {
  await pool.query(
    "UPDATE ai_jobs SET status='FAILED',error_category=$3,completed_at=now() WHERE id=$1 AND workspace_id=$2 AND status IN ('QUEUED','PROCESSING','FAILED')",
    [data.jobId, data.workspaceId, reason],
  );
}

export async function processJob(pool: Pool, kms: KMSClient, job: Job<AiJob>) {
  const data = aiJobSchema.parse(job.data);
  let resolved: ResolvedJobProvider;
  try {
    resolved = await providerForJob(pool, kms, data);
  } catch (error) {
    if (error instanceof AiEntitlementDenied) {
      await markDenied(pool, data, error.reason);
      return;
    }
    throw error;
  }
  const { provider } = resolved;
  const claimed = await pool.query<{ input_hash: string }>(
    "UPDATE ai_jobs SET status='PROCESSING',started_at=now(),provider=$2,model=coalesce(model,$3),error_category=NULL WHERE id=$1 AND workspace_id=$4 AND status IN ('QUEUED','FAILED') RETURNING input_hash",
    [
      data.jobId,
      provider.name,
      process.env.AI_MODEL ?? "gpt-5-mini",
      data.workspaceId,
    ],
  );
  if (!claimed.rowCount) return;
  try {
    const input = await pool.query<{ text: string; revision: number }>(
      "SELECT string_agg('['||s.start_ms||'-'||s.end_ms||'] '||COALESCE(s.corrected_text,s.provider_text),E'\\n' ORDER BY s.ordinal) text,t.correction_revision revision FROM transcripts t JOIN transcript_segments s ON s.transcript_id=t.id WHERE t.id=$1 AND t.workspace_id=$2 AND t.recording_id=$3 AND t.status='READY' GROUP BY t.id",
      [data.transcriptId, data.workspaceId, data.recordingId],
    );
    const transcript = input.rows[0];
    if (
      !transcript ||
      transcript.revision !== data.transcriptRevision ||
      transcriptInputHash(transcript.text, transcript.revision) !==
        claimed.rows[0]!.input_hash
    )
      throw new Error("Transcript changed after AI job was authorized");
    const result = await provider.generate({
      capability: data.capability,
      transcript: transcript.text,
      ...(data.question ? { question: data.question } : {}),
      ...(data.targetLanguage ? { targetLanguage: data.targetLanguage } : {}),
    });
    const transaction: PoolClient = await pool.connect();
    try {
      const artifactId = randomUUID();
      await transaction.query("BEGIN");
      await transaction.query(
        "INSERT INTO ai_artifacts(id,job_id,workspace_id,recording_id,capability,content) VALUES($1,$2,$3,$4,$5,$6)",
        [
          artifactId,
          data.jobId,
          data.workspaceId,
          data.recordingId,
          data.capability,
          result.content,
        ],
      );
      await transaction.query(
        "INSERT INTO webhook_outbox (event, workspace_id, aggregate_id, payload) VALUES ('ai_artifact.created', $1, $2, $3::jsonb)",
        [
          data.workspaceId,
          artifactId,
          JSON.stringify({
            artifactId,
            recordingId: data.recordingId,
            capability: data.capability,
          }),
        ],
      );
      if (resolved.connectionId)
        await transaction.query(
          "UPDATE ai_provider_connections SET last_used_at=now() WHERE id=$1 AND workspace_id=$2",
          [resolved.connectionId, data.workspaceId],
        );
      // The ledger row rides the same transaction as the artifact, so metered
      // spend and completed work can never disagree.
      await recordAiUsage(transaction, {
        workspaceId: data.workspaceId,
        purpose: "ANALYSIS",
        lane: resolved.lane,
        sourceKind: "AI_JOB",
        sourceId: data.jobId,
        connectionId: resolved.connectionId,
        provider: result.provider,
        model: result.model,
        units: result.inputTokens + result.outputTokens,
        unitKind: "TOKENS",
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicrounits: result.costMicrounits,
        currency: result.currency,
        markupPercent: managedMarkupPercentFromEnvironment(process.env),
      });
      await transaction.query(
        "UPDATE ai_jobs SET status='COMPLETED',provider=$2,model=$3,input_tokens=$4,output_tokens=$5,cost_microunits=$6,currency=$7,provider_request_id_hash=$8,provider_connection_id=$9,completed_at=now() WHERE id=$1",
        [
          data.jobId,
          result.provider,
          result.model,
          result.inputTokens,
          result.outputTokens,
          result.costMicrounits,
          result.currency,
          result.requestId
            ? createHash("sha256").update(result.requestId).digest("hex")
            : null,
          resolved.connectionId,
        ],
      );
      await transaction.query("COMMIT");
    } catch (error) {
      await transaction.query("ROLLBACK");
      throw error;
    } finally {
      transaction.release();
    }
  } catch (error) {
    await pool.query(
      "UPDATE ai_jobs SET status='FAILED',error_category=$2,completed_at=now() WHERE id=$1",
      [data.jobId, error instanceof Error ? error.name : "UnknownError"],
    );
    throw error;
  }
}
