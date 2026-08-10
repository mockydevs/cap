import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import {
  PROMPT_TEMPLATE_VERSION,
  transcriptInputHash,
  type AiCapability,
} from "@cap/ai";
import { aiJobOptions, createAiQueue, createRedisConnection } from "@cap/queue";
import { db } from "../../db/client";
import {
  aiArtifacts,
  aiJobs,
  aiProviderConnections,
  aiProviderRoutes,
  aiSearchDocuments,
  aiWorkspacePolicies,
  recordings,
  transcriptSegments,
  transcripts,
} from "../../db/schema";
import type { Actor } from "../auth/session";
import { cosine, embedTexts } from "./embedding";
export class AiServiceError extends Error {
  constructor(
    readonly code:
      | "AI_DISABLED"
      | "EXTERNAL_AI_DISABLED"
      | "TRANSCRIPT_NOT_READY"
      | "AI_QUOTA_EXCEEDED"
      | "AI_NOT_FOUND"
      | "AI_QUEUE_NOT_CONFIGURED"
      | "AI_PROVIDER_NOT_CONFIGURED"
      | "AI_PROVIDER_VALIDATION_FAILED"
      | "AI_CREDENTIAL_ENCRYPTION_UNAVAILABLE",
    readonly status: number,
  ) {
    super(code);
  }
}
const approvedText = sql<string>`string_agg('['||${transcriptSegments.startMs}||'-'||${transcriptSegments.endMs}||'] '||coalesce(${transcriptSegments.correctedText},${transcriptSegments.providerText}), E'\n' ORDER BY ${transcriptSegments.ordinal})`;
export async function createAiJob(
  recordingId: string,
  actor: Actor,
  input: {
    capability: AiCapability;
    question?: string;
    targetLanguage?: string;
  },
) {
  const [policy] = await db()
    .select()
    .from(aiWorkspacePolicies)
    .where(eq(aiWorkspacePolicies.workspaceId, actor.workspaceId))
    .limit(1);
  if (!policy?.enabled) throw new AiServiceError("AI_DISABLED", 403);
  if (
    policy.allowedProvider === "openai-compatible" &&
    !policy.allowExternalProcessing
  )
    throw new AiServiceError("EXTERNAL_AI_DISABLED", 403);
  const month = new Date();
  month.setUTCDate(1);
  month.setUTCHours(0, 0, 0, 0);
  const [usage] = await db()
    .select({
      tokens: sql<number>`coalesce(sum(coalesce(${aiJobs.inputTokens},0)+coalesce(${aiJobs.outputTokens},0)),0)::int`,
      cost: sql<number>`coalesce(sum(${aiJobs.costMicrounits}),0)::bigint`,
    })
    .from(aiJobs)
    .where(
      and(
        eq(aiJobs.workspaceId, actor.workspaceId),
        gte(aiJobs.createdAt, month),
      ),
    );
  if (
    (usage?.tokens ?? 0) >= policy.monthlyTokenLimit ||
    (usage?.cost ?? 0) >= policy.monthlyCostLimitMicrounits
  )
    throw new AiServiceError("AI_QUOTA_EXCEEDED", 429);
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
  const [route] = await db()
    .select({
      connectionId: aiProviderRoutes.connectionId,
      model: aiProviderRoutes.model,
    })
    .from(aiProviderRoutes)
    .innerJoin(
      aiProviderConnections,
      eq(aiProviderConnections.id, aiProviderRoutes.connectionId),
    )
    .where(
      and(
        eq(aiProviderRoutes.workspaceId, actor.workspaceId),
        eq(aiProviderRoutes.purpose, "ANALYSIS"),
        eq(aiProviderConnections.status, "ACTIVE"),
      ),
    )
    .limit(1);
  if (!route && process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL !== "true")
    throw new AiServiceError("AI_PROVIDER_NOT_CONFIGURED", 409);
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
      ...(route
        ? { providerConnectionId: route.connectionId, model: route.model }
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
  const policy = await getPolicy(actor);
  if (!policy.enabled) throw new AiServiceError("AI_DISABLED", 403);
  if (
    !policy.allowExternalProcessing &&
    policy.allowedProvider === "openai-compatible"
  )
    throw new AiServiceError("EXTERNAL_AI_DISABLED", 403);
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
  const missing = segments.filter(
    (segment) =>
      bySegment.get(segment.segmentId)?.contentHash !==
      createHash("sha256").update(segment.content).digest("hex"),
  );
  for (let offset = 0; offset < missing.length; offset += 64) {
    const batch = missing.slice(offset, offset + 64);
    const vectors = await embedTexts(batch.map((item) => item.content));
    for (let index = 0; index < batch.length; index += 1) {
      const segment = batch[index]!;
      const vector = vectors[index]!;
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
  const [queryVector] = await embedTexts([query]);
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
