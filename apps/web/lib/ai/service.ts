import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import {
  estimateTokenCostMicrounits,
  PROMPT_TEMPLATE_VERSION,
  transcriptInputHash,
  type AiCapability,
} from "@cap/ai";
import { aiJobOptions, createAiQueue, createRedisConnection } from "@cap/queue";
import { db } from "../../db/client";
import {
  aiArtifacts,
  aiJobs,
  aiSearchDocuments,
  aiWorkspacePolicies,
  recordings,
  transcriptSegments,
  transcripts,
} from "../../db/schema";
import type { Actor } from "../auth/session";
import { cosine, embedTexts } from "./embedding";
import {
  loadEntitlement,
  monthlyUsage,
  recordAiUsage,
  requireEntitlement,
  resolveCredential,
  unknownModelRate,
} from "./entitlement";
import { AiServiceError } from "./errors";
export { AiServiceError };
const approvedText = sql<string>`string_agg('['||${transcriptSegments.startMs}||'-'||${transcriptSegments.endMs}||'] '||coalesce(${transcriptSegments.correctedText},${transcriptSegments.providerText}), E'\n' ORDER BY ${transcriptSegments.ordinal})`;
/** Exposes the same monthly consumption the entitlement resolver enforces
 * against, so the admin settings screen can show spend instead of leaving the
 * configured ceiling as write-only. */
export async function getMonthlyUsage(actor: Actor) {
  return monthlyUsage(actor.workspaceId);
}
/** Which lane, if any, will pay for each purpose — drives the settings screen
 * and the inline prompts on every AI surface. */
export async function getEntitlements(actor: Actor) {
  const [analysis, embeddings, transcription] = await Promise.all([
    loadEntitlement(actor.workspaceId, "ANALYSIS"),
    loadEntitlement(actor.workspaceId, "EMBEDDINGS"),
    loadEntitlement(actor.workspaceId, "TRANSCRIPTION"),
  ]);
  return { analysis, embeddings, transcription };
}
export async function createAiJob(
  recordingId: string,
  actor: Actor,
  input: {
    capability: AiCapability;
    question?: string;
    targetLanguage?: string;
  },
) {
  const entitlement = await requireEntitlement(actor.workspaceId, "ANALYSIS");
  const [source] = await db()
    .select({
      transcriptId: transcripts.id,
      revision: transcripts.correctionRevision,
      text: approvedText,
    })
    .from(transcripts)
    .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
    .innerJoin(
      transcriptSegments,
      eq(transcriptSegments.transcriptId, transcripts.id),
    )
    .where(
      and(
        eq(recordings.id, recordingId),
        eq(recordings.workspaceId, actor.workspaceId),
        ne(recordings.status, "DELETED"),
        eq(transcripts.status, "READY"),
        eq(transcriptSegments.isOrphaned, false),
      ),
    )
    .groupBy(transcripts.id)
    .limit(1);
  if (!source) throw new AiServiceError("TRANSCRIPT_NOT_READY", 409);
  const id = randomUUID();
  await db()
    .insert(aiJobs)
    .values({
      id,
      workspaceId: actor.workspaceId,
      recordingId,
      transcriptId: source.transcriptId,
      transcriptRevision: source.revision,
      inputHash: transcriptInputHash(source.text, source.revision),
      capability: input.capability,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      // Only the bring-your-own-key lane pins a connection; the managed and
      // deployment lanes are performed with the deployment credential, and the
      // worker re-resolves the lane so a key revoked between enqueue and run
      // still fails closed.
      ...(entitlement.lane === "BYOK"
        ? {
            providerConnectionId: entitlement.connectionId,
            model: entitlement.model,
          }
        : {}),
      requestedBy: actor.userId,
      ...(input.question ? { question: input.question } : {}),
      ...(input.targetLanguage ? { targetLanguage: input.targetLanguage } : {}),
    });
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    await db().delete(aiJobs).where(eq(aiJobs.id, id));
    throw new AiServiceError("AI_QUEUE_NOT_CONFIGURED", 503);
  }
  const connection = createRedisConnection(redisUrl),
    queue = createAiQueue(connection);
  try {
    await queue.add(
      "generate",
      {
        jobId: id,
        workspaceId: actor.workspaceId,
        recordingId,
        transcriptId: source.transcriptId,
        transcriptRevision: source.revision,
        capability: input.capability,
        requestedBy: actor.userId,
        ...(input.question ? { question: input.question } : {}),
        ...(input.targetLanguage
          ? { targetLanguage: input.targetLanguage }
          : {}),
      },
      aiJobOptions(id),
    );
  } catch (error) {
    await db()
      .update(aiJobs)
      .set({
        status: "FAILED",
        errorCategory: "QueueUnavailable",
        completedAt: new Date(),
      })
      .where(eq(aiJobs.id, id));
    throw error;
  } finally {
    await queue.close();
    connection.disconnect();
  }
  return { id, status: "QUEUED" as const };
}
export async function listAi(recordingId: string, actor: Actor) {
  const jobs = await db()
    .select({
      id: aiJobs.id,
      capability: aiJobs.capability,
      status: aiJobs.status,
      errorCategory: aiJobs.errorCategory,
      inputTokens: aiJobs.inputTokens,
      outputTokens: aiJobs.outputTokens,
      costMicrounits: aiJobs.costMicrounits,
      currency: aiJobs.currency,
      createdAt: aiJobs.createdAt,
      content: aiArtifacts.content,
      artifactId: aiArtifacts.id,
      artifactStatus: aiArtifacts.status,
    })
    .from(aiJobs)
    .leftJoin(aiArtifacts, eq(aiArtifacts.jobId, aiJobs.id))
    .where(
      and(
        eq(aiJobs.recordingId, recordingId),
        eq(aiJobs.workspaceId, actor.workspaceId),
      ),
    )
    .orderBy(asc(aiJobs.createdAt));
  return jobs.map((item) => ({
    ...item,
    createdAt: item.createdAt.toISOString(),
  }));
}
export async function decideArtifact(
  recordingId: string,
  artifactId: string,
  actor: Actor,
  status: "ACCEPTED" | "REJECTED",
) {
  const [updated] = await db()
    .update(aiArtifacts)
    .set({
      status,
      ...(status === "ACCEPTED"
        ? { acceptedBy: actor.userId, acceptedAt: new Date() }
        : { acceptedBy: null, acceptedAt: null }),
    })
    .where(
      and(
        eq(aiArtifacts.id, artifactId),
        eq(aiArtifacts.recordingId, recordingId),
        eq(aiArtifacts.workspaceId, actor.workspaceId),
        eq(aiArtifacts.status, "SUGGESTED"),
      ),
    )
    .returning({ id: aiArtifacts.id, status: aiArtifacts.status });
  if (!updated) throw new AiServiceError("AI_NOT_FOUND", 404);
  return updated;
}
export async function getPolicy(actor: Actor) {
  return (
    (
      await db()
        .select()
        .from(aiWorkspacePolicies)
        .where(eq(aiWorkspacePolicies.workspaceId, actor.workspaceId))
        .limit(1)
    )[0] ?? {
      workspaceId: actor.workspaceId,
      enabled: false,
      allowedProvider: "openai-compatible",
      allowExternalProcessing: false,
      monthlyTokenLimit: 1_000_000,
      monthlyCostLimitMicrounits: 25_000_000,
    }
  );
}
export async function setPolicy(
  actor: Actor,
  input: {
    enabled: boolean;
    allowedProvider: string;
    allowExternalProcessing: boolean;
    monthlyTokenLimit: number;
    monthlyCostLimitMicrounits: number;
  },
) {
  if (actor.role !== "OWNER" && actor.role !== "ADMIN")
    throw new AiServiceError("AI_NOT_FOUND", 403);
  return (
    await db()
      .insert(aiWorkspacePolicies)
      .values({
        ...input,
        workspaceId: actor.workspaceId,
        updatedBy: actor.userId,
      })
      .onConflictDoUpdate({
        target: aiWorkspacePolicies.workspaceId,
        set: { ...input, updatedBy: actor.userId, updatedAt: new Date() },
      })
      .returning()
  )[0]!;
}

export async function semanticSearch(
  actor: Actor,
  query: string,
  limit: number,
) {
  const entitlement = await requireEntitlement(actor.workspaceId, "EMBEDDINGS");
  const credential = await resolveCredential(
    actor.workspaceId,
    entitlement,
    process.env.AI_EMBEDDING_MODEL ?? "text-embedding-3-small",
  );
  let embeddedTokens = 0;
  const segments = await db()
    .select({
      segmentId: transcriptSegments.id,
      transcriptId: transcripts.id,
      recordingId: recordings.id,
      title: recordings.title,
      startMs: transcriptSegments.startMs,
      endMs: transcriptSegments.endMs,
      content: sql<string>`coalesce(${transcriptSegments.correctedText}, ${transcriptSegments.providerText})`,
    })
    .from(transcriptSegments)
    .innerJoin(transcripts, eq(transcripts.id, transcriptSegments.transcriptId))
    .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
    .where(
      and(
        eq(transcripts.workspaceId, actor.workspaceId),
        eq(transcripts.status, "READY"),
        eq(transcriptSegments.isOrphaned, false),
        ne(recordings.status, "DELETED"),
      ),
    )
    .limit(500);
  const existing = await db()
    .select()
    .from(aiSearchDocuments)
    .where(eq(aiSearchDocuments.workspaceId, actor.workspaceId));
  const bySegment = new Map(existing.map((item) => [item.segmentId, item]));
  // Indexing is bounded per request: an unindexed workspace would otherwise
  // embed every segment inside one search, spending an unpredictable amount of
  // the caller's money and holding the request open while it does. Successive
  // searches pick up where this one stopped.
  const backfillLimit = Number(
    process.env.AI_EMBEDDING_BACKFILL_LIMIT ?? "128",
  );
  const missing = segments
    .filter(
      (segment) =>
        bySegment.get(segment.segmentId)?.contentHash !==
        createHash("sha256").update(segment.content).digest("hex"),
    )
    .slice(
      0,
      Number.isFinite(backfillLimit) ? Math.max(0, backfillLimit) : 128,
    );
  for (let offset = 0; offset < missing.length; offset += 64) {
    const batch = missing.slice(offset, offset + 64);
    const embedded = await embedTexts(
      batch.map((item) => item.content),
      credential,
    );
    embeddedTokens += embedded.inputTokens;
    for (let index = 0; index < batch.length; index += 1) {
      const segment = batch[index]!;
      const vector = embedded.vectors[index]!;
      const contentHash = createHash("sha256")
        .update(segment.content)
        .digest("hex");
      const [saved] = await db()
        .insert(aiSearchDocuments)
        .values({
          id: randomUUID(),
          workspaceId: actor.workspaceId,
          recordingId: segment.recordingId,
          transcriptId: segment.transcriptId,
          segmentId: segment.segmentId,
          startMs: segment.startMs,
          endMs: segment.endMs,
          content: segment.content,
          contentHash,
          embedding: vector.embedding,
          model: vector.model,
        })
        .onConflictDoUpdate({
          target: aiSearchDocuments.segmentId,
          set: {
            content: segment.content,
            contentHash,
            embedding: vector.embedding,
            model: vector.model,
            updatedAt: new Date(),
          },
        })
        .returning();
      bySegment.set(segment.segmentId, saved!);
    }
  }
  const queryBatch = await embedTexts([query], credential);
  embeddedTokens += queryBatch.inputTokens;
  const queryVector = queryBatch.vectors[0];
  await recordAiUsage({
    workspaceId: actor.workspaceId,
    purpose: "EMBEDDINGS",
    lane: entitlement.lane,
    sourceKind: "EMBEDDING_BATCH",
    sourceId: randomUUID(),
    connectionId: credential.connectionId,
    provider: credential.provider,
    model: credential.model,
    units: embeddedTokens,
    unitKind: "TOKENS",
    inputTokens: embeddedTokens,
    costMicrounits: estimateTokenCostMicrounits({
      model: credential.model,
      inputTokens: embeddedTokens,
      outputTokens: 0,
      fallback: unknownModelRate(),
    }),
  });
  if (!queryVector) return [];
  return segments
    .map((segment) => {
      const document = bySegment.get(segment.segmentId);
      return {
        recordingId: segment.recordingId,
        title: segment.title,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.content,
        score: document
          ? cosine(queryVector.embedding, document.embedding)
          : -1,
      };
    })
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
