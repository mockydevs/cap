import { and, eq, gte, sql } from "drizzle-orm";
import {
  AI_DENIAL_STATUS,
  applyManagedMarkup,
  resolveAiEntitlement,
  trialCreditFromEnvironment,
  unknownTokenRateFromEnvironment,
  type AiEntitlement,
  type AiPurpose,
  type AiUsageLane,
  type AiUsageUnitKind,
  type TokenRate,
} from "@cap/ai";
import { decryptCredential } from "@cap/crypto";
import { db } from "../../db/client";
import {
  aiProviderConnections,
  aiProviderRoutes,
  aiUsageEvents,
  aiWorkspacePolicies,
} from "../../db/schema";
import { loadSubscriptionFacts } from "../billing/service";
import { managedMarkupPercent } from "../billing/plans";
import { AiServiceError } from "./errors";

/**
 * The web app's half of the entitlement decision: load the facts, hand them to
 * the shared resolver in `@cap/ai`, and translate a denial into the HTTP error
 * every AI surface already speaks. The workers load the same facts from raw
 * SQL and call the same resolver, so a request that is authorized here cannot
 * be judged differently by the process that performs it.
 */

function currentMonthStart(): Date {
  const month = new Date();
  month.setUTCDate(1);
  month.setUTCHours(0, 0, 0, 0);
  return month;
}

/**
 * Metered consumption for the calendar month, from the usage ledger. Reading
 * one table is what lets a workspace ceiling cover analysis, transcription and
 * embeddings together instead of only the jobs that happen to have a row in
 * `ai_jobs`.
 */
export async function monthlyUsage(workspaceId: string) {
  const [usage] = await db()
    .select({
      tokens: sql<number>`coalesce(sum(${aiUsageEvents.units}) filter (where ${aiUsageEvents.unitKind} = 'TOKENS'),0)::bigint`,
      audioMs: sql<number>`coalesce(sum(${aiUsageEvents.units}) filter (where ${aiUsageEvents.unitKind} = 'AUDIO_MS'),0)::bigint`,
      cost: sql<number>`coalesce(sum(${aiUsageEvents.costMicrounits}),0)::bigint`,
    })
    .from(aiUsageEvents)
    .where(
      and(
        eq(aiUsageEvents.workspaceId, workspaceId),
        gte(aiUsageEvents.occurredAt, currentMonthStart()),
      ),
    );
  return {
    tokens: Number(usage?.tokens ?? 0),
    audioMs: Number(usage?.audioMs ?? 0),
    costMicrounits: Number(usage?.cost ?? 0),
  };
}

/**
 * Lifetime managed spend, which is what a trial allowance is measured against.
 * Only queried when the deployment offers one.
 */
async function lifetimeManagedSpend(workspaceId: string) {
  const [row] = await db()
    .select({
      charged: sql<number>`coalesce(sum(${aiUsageEvents.chargedMicrounits}),0)::bigint`,
    })
    .from(aiUsageEvents)
    .where(
      and(
        eq(aiUsageEvents.workspaceId, workspaceId),
        eq(aiUsageEvents.lane, "MANAGED"),
      ),
    );
  return Number(row?.charged ?? 0);
}

async function activeRoute(workspaceId: string, purpose: AiPurpose) {
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
        eq(aiProviderRoutes.workspaceId, workspaceId),
        eq(aiProviderRoutes.purpose, purpose),
        eq(aiProviderConnections.status, "ACTIVE"),
      ),
    )
    .limit(1);
  return route ?? null;
}

export async function loadEntitlement(
  workspaceId: string,
  purpose: AiPurpose,
): Promise<AiEntitlement> {
  const [policy] = await db()
    .select()
    .from(aiWorkspacePolicies)
    .where(eq(aiWorkspacePolicies.workspaceId, workspaceId))
    .limit(1);
  const trialCredit = trialCreditFromEnvironment(process.env);
  const [route, subscription, usage, trialSpend] = await Promise.all([
    activeRoute(workspaceId, purpose),
    loadSubscriptionFacts(workspaceId),
    monthlyUsage(workspaceId),
    trialCredit ? lifetimeManagedSpend(workspaceId) : Promise.resolve(0),
  ]);
  return resolveAiEntitlement({
    purpose,
    policy: policy ?? null,
    route,
    subscription,
    trial: trialCredit
      ? {
          includedCreditMicrounits: trialCredit,
          consumedCreditMicrounits: trialSpend,
        }
      : null,
    usage,
    deploymentCredentialAllowed:
      process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL === "true",
    now: new Date(),
  });
}

/** Same decision, raised as the error the AI routes already translate. */
export async function requireEntitlement(
  workspaceId: string,
  purpose: AiPurpose,
) {
  const entitlement = await loadEntitlement(workspaceId, purpose);
  if (entitlement.lane === "NONE")
    throw new AiServiceError(
      entitlement.reason,
      AI_DENIAL_STATUS[entitlement.reason],
    );
  return entitlement;
}

export interface ResolvedAiCredential {
  readonly lane: AiUsageLane;
  readonly connectionId: string | null;
  readonly provider: "OPENAI" | "ANTHROPIC" | "OPENAI_COMPATIBLE";
  readonly baseUrl: string | null;
  readonly apiKey: string;
  readonly model: string;
}

/**
 * Unseals the credential a resolved lane should use. The plaintext is returned
 * to the caller for immediate use and never stored or logged; the workspace's
 * own key is only ever read here and in the workers.
 */
export async function resolveCredential(
  workspaceId: string,
  entitlement: Exclude<AiEntitlement, { lane: "NONE" }>,
  fallbackModel: string,
): Promise<ResolvedAiCredential> {
  if (entitlement.lane !== "BYOK") {
    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) throw new AiServiceError("AI_PROVIDER_NOT_CONFIGURED", 409);
    return {
      lane: entitlement.lane,
      connectionId: null,
      provider: "OPENAI",
      baseUrl: process.env.AI_BASE_URL ?? null,
      apiKey,
      model: fallbackModel,
    };
  }
  const [connection] = await db()
    .select({
      provider: aiProviderConnections.provider,
      baseUrl: aiProviderConnections.baseUrl,
      encryptedCredential: aiProviderConnections.encryptedCredential,
      credentialKeyArn: aiProviderConnections.credentialKeyArn,
    })
    .from(aiProviderConnections)
    .where(
      and(
        eq(aiProviderConnections.id, entitlement.connectionId),
        eq(aiProviderConnections.workspaceId, workspaceId),
        eq(aiProviderConnections.status, "ACTIVE"),
      ),
    )
    .limit(1);
  if (!connection) throw new AiServiceError("AI_PROVIDER_NOT_CONFIGURED", 409);
  return {
    lane: "BYOK",
    connectionId: entitlement.connectionId,
    provider: connection.provider,
    baseUrl: connection.baseUrl,
    apiKey: await decryptCredential({
      workspaceId,
      purpose: "ai-provider-credential",
      ciphertext: connection.encryptedCredential,
      keyReference: connection.credentialKeyArn,
    }),
    model: entitlement.model,
  };
}

/** Operator override for models Cap publishes no rate for. */
export function unknownModelRate(): TokenRate | undefined {
  return unknownTokenRateFromEnvironment(process.env);
}

/**
 * How much plan credit a unit of work consumes. Only the managed lane draws
 * credit — a workspace paying its own provider is metered for its ceiling and
 * charged nothing here.
 */
export function chargedMicrounits(
  lane: AiUsageLane,
  costMicrounits: number,
): number {
  return lane === "MANAGED"
    ? applyManagedMarkup(costMicrounits, managedMarkupPercent())
    : 0;
}

export async function recordAiUsage(input: {
  readonly workspaceId: string;
  readonly purpose: AiPurpose;
  readonly lane: AiUsageLane;
  readonly sourceKind: "AI_JOB" | "TRANSCRIPTION_RUN" | "EMBEDDING_BATCH";
  readonly sourceId: string;
  readonly connectionId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly units: number;
  readonly unitKind: AiUsageUnitKind;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly costMicrounits: number;
}) {
  await db()
    .insert(aiUsageEvents)
    .values({
      workspaceId: input.workspaceId,
      purpose: input.purpose,
      lane: input.lane,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      connectionId: input.connectionId,
      provider: input.provider,
      model: input.model,
      units: input.units,
      unitKind: input.unitKind,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      costMicrounits: input.costMicrounits,
      chargedMicrounits: chargedMicrounits(input.lane, input.costMicrounits),
    })
    // A retried source must not be counted twice; the first write wins.
    .onConflictDoNothing({
      target: [aiUsageEvents.sourceKind, aiUsageEvents.sourceId],
    });
}
