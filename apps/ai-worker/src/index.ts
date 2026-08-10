import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Worker, type Job } from "bullmq";
import { Pool } from "pg";
import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
import {
  AI_QUEUE,
  aiJobSchema,
  createRedisConnection,
  type AiJob,
} from "@cap/queue";
import { transcriptInputHash } from "@cap/ai";
import { providerFromConnection, providerFromEnvironment } from "./provider";
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
};
const pool = new Pool({ connectionString: required("DATABASE_URL") });
const connection = createRedisConnection(required("REDIS_URL"));
const kms = new KMSClient(
  process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {},
);
async function providerForJob(data: AiJob) {
  const selected = await pool.query<{
    provider_connection_id: string | null;
    model: string | null;
    provider: "OPENAI" | "ANTHROPIC" | "OPENAI_COMPATIBLE" | null;
    base_url: string | null;
    encrypted_credential: string | null;
    credential_key_arn: string | null;
  }>(
    "SELECT j.provider_connection_id,j.model,c.provider,c.base_url,c.encrypted_credential,c.credential_key_arn FROM ai_jobs j LEFT JOIN ai_provider_connections c ON c.id=j.provider_connection_id AND c.workspace_id=j.workspace_id AND c.status='ACTIVE' WHERE j.id=$1 AND j.workspace_id=$2",
    [data.jobId, data.workspaceId],
  );
  const connection = selected.rows[0];
  if (!connection) throw new Error("AI job is not available");
  if (!connection.provider_connection_id) {
    if (process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL !== "true")
      throw new Error("AI provider connection is required");
    return providerFromEnvironment();
  }
  if (
    !connection.provider ||
    !connection.encrypted_credential ||
    !connection.credential_key_arn ||
    !connection.model
  )
    throw new Error("AI provider connection is unavailable");
  const decrypted = await kms.send(
    new DecryptCommand({
      KeyId: connection.credential_key_arn,
      CiphertextBlob: Buffer.from(connection.encrypted_credential, "base64"),
      EncryptionContext: {
        application: "cap",
        workspaceId: data.workspaceId,
        purpose: "ai-provider-credential",
      },
    }),
  );
  if (!decrypted.Plaintext)
    throw new Error("AI provider credential could not be decrypted");
  return providerFromConnection({
    provider: connection.provider,
    baseUrl: connection.base_url,
    apiKey: Buffer.from(decrypted.Plaintext).toString("utf8"),
    model: connection.model,
  });
}
async function processJob(job: Job<AiJob>) {
  const data = aiJobSchema.parse(job.data);
  const provider = await providerForJob(data);
  const policy = await pool.query<{
    enabled: boolean;
    allowed_provider: string;
    allow_external_processing: boolean;
  }>(
    "SELECT enabled,allowed_provider,allow_external_processing FROM ai_workspace_policies WHERE workspace_id=$1",
    [data.workspaceId],
  );
  const workspacePolicy = policy.rows[0];
  if (!workspacePolicy?.enabled || !workspacePolicy.allow_external_processing) {
    await pool.query(
      "UPDATE ai_jobs SET status='FAILED',error_category='PolicyDenied',completed_at=now() WHERE id=$1 AND workspace_id=$2 AND status IN ('QUEUED','FAILED')",
      [data.jobId, data.workspaceId],
    );
    return;
  }
  const claimed = await pool.query(
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
        claimed.rows[0].input_hash
    )
      throw new Error("Transcript changed after AI job was authorized");
    const result = await provider.generate({
      capability: data.capability,
      transcript: transcript.text,
      ...(data.question ? { question: data.question } : {}),
      ...(data.targetLanguage ? { targetLanguage: data.targetLanguage } : {}),
    });
    const transaction = await pool.connect();
    try {
      await transaction.query("BEGIN");
      await transaction.query(
        "INSERT INTO ai_artifacts(id,job_id,workspace_id,recording_id,capability,content) VALUES($1,$2,$3,$4,$5,$6)",
        [
          randomUUID(),
          data.jobId,
          data.workspaceId,
          data.recordingId,
          data.capability,
          result.content,
        ],
      );
      if (data.jobId)
        await transaction.query(
          "UPDATE ai_provider_connections SET last_used_at=now() WHERE id=(SELECT provider_connection_id FROM ai_jobs WHERE id=$1)",
          [data.jobId],
        );
      await transaction.query(
        "UPDATE ai_jobs SET status='COMPLETED',provider=$2,model=$3,input_tokens=$4,output_tokens=$5,cost_microunits=$6,currency=$7,provider_request_id_hash=$8,completed_at=now() WHERE id=$1",
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
let ready = false;
const worker = new Worker<AiJob>(AI_QUEUE, processJob, {
  connection,
  concurrency: Number(process.env.AI_WORKER_CONCURRENCY ?? "2"),
});
worker.on("ready", () => {
  ready = true;
});
worker.on("failed", (job, error) =>
  console.error("AI job failed", job?.id, error.name),
);
const server = createServer((request, response) => {
  if (request.url !== "/health") return void response.writeHead(404).end();
  response
    .writeHead(ready ? 200 : 503, { "content-type": "application/json" })
    .end(JSON.stringify({ status: ready ? "ok" : "starting" }));
});
server.listen(Number(process.env.AI_WORKER_HEALTH_PORT ?? "8084"), "0.0.0.0");
async function shutdown() {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await worker.close();
  await connection.quit();
  await pool.end();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
