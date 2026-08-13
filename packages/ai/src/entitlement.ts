import type { ProviderCapability } from "./index";

/**
 * Who pays for a unit of AI work, decided in one place.
 *
 * Cap runs three AI purposes (transcript analysis, embeddings, transcription)
 * across a web app and two workers. Before this resolver each of those answered
 * "may this run, and on whose credential?" for itself — which is how
 * transcription ended up billing the deployment for every recording while the
 * settings screen advertised a workspace key it never read. The rule lives
 * here, as a pure function over facts each caller loads for itself, so the
 * answer cannot drift between the process that authorizes work and the process
 * that performs it.
 */

/** A routable AI purpose. Same set as a connection's declared capabilities. */
export type AiPurpose = ProviderCapability;

export type AiDenialReason =
  /** The workspace has not switched AI on. */
  | "AI_DISABLED"
  /** The workspace forbids sending transcripts to a third party. */
  | "EXTERNAL_AI_DISABLED"
  /** The workspace's own monthly token or cost ceiling is spent. */
  | "AI_QUOTA_EXCEEDED"
  /** A Cap plan is active but its included credit for this period is spent. */
  | "AI_CREDIT_EXHAUSTED"
  /** No workspace key routed for this purpose and no plan to fall back on. */
  | "AI_PROVIDER_NOT_CONFIGURED";

export type AiEntitlement =
  /** Charge the workspace's own provider credential. */
  | {
      readonly lane: "BYOK";
      readonly connectionId: string;
      readonly model: string;
    }
  /** Charge the workspace's Cap plan; the deployment credential performs it. */
  | {
      readonly lane: "MANAGED";
      readonly planCode: string;
      readonly remainingCreditMicrounits: number;
    }
  /** Self-hosted escape hatch: the operator has opted in to paying. */
  | { readonly lane: "DEPLOYMENT" }
  | { readonly lane: "NONE"; readonly reason: AiDenialReason };

export interface AiPolicyFacts {
  readonly enabled: boolean;
  readonly allowedProvider: string;
  readonly allowExternalProcessing: boolean;
  readonly monthlyTokenLimit: number;
  readonly monthlyCostLimitMicrounits: number;
}

/** An active provider connection bound to this purpose. */
export interface AiRouteFacts {
  readonly connectionId: string;
  readonly model: string;
}

export interface AiSubscriptionFacts {
  readonly status: string;
  readonly planCode: string;
  readonly currentPeriodEnd: Date;
  readonly includedCreditMicrounits: number;
  readonly consumedCreditMicrounits: number;
}

/** Metered spend for the current calendar month, across every purpose. */
export interface AiUsageFacts {
  readonly tokens: number;
  readonly costMicrounits: number;
}

export interface AiEntitlementFacts {
  readonly purpose: AiPurpose;
  readonly policy: AiPolicyFacts | null;
  readonly route: AiRouteFacts | null;
  readonly subscription: AiSubscriptionFacts | null;
  readonly usage: AiUsageFacts;
  /** `AI_ALLOW_DEPLOYMENT_CREDENTIAL`, resolved by the caller. */
  readonly deploymentCredentialAllowed: boolean;
  readonly now: Date;
}

/** Statuses under which a subscription still buys AI work. */
const PAYING_STATUSES = new Set(["ACTIVE", "TRIALING"]);

/**
 * A workspace that points Cap at its own inference endpoint has not consented
 * to third-party processing because there is none; any other lane sends
 * transcript text off the deployment and does need that consent.
 */
function sendsTranscriptsOffPremises(policy: AiPolicyFacts): boolean {
  return policy.allowedProvider !== "self-hosted";
}

function subscriptionCredit(
  subscription: AiSubscriptionFacts,
  now: Date,
): number | null {
  if (!PAYING_STATUSES.has(subscription.status)) return null;
  if (subscription.currentPeriodEnd.getTime() <= now.getTime()) return null;
  return Math.max(
    0,
    subscription.includedCreditMicrounits -
      subscription.consumedCreditMicrounits,
  );
}

export function resolveAiEntitlement(facts: AiEntitlementFacts): AiEntitlement {
  const { policy } = facts;
  if (!policy?.enabled) return { lane: "NONE", reason: "AI_DISABLED" };
  if (sendsTranscriptsOffPremises(policy) && !policy.allowExternalProcessing)
    return { lane: "NONE", reason: "EXTERNAL_AI_DISABLED" };
  if (
    facts.usage.tokens >= policy.monthlyTokenLimit ||
    facts.usage.costMicrounits >= policy.monthlyCostLimitMicrounits
  )
    return { lane: "NONE", reason: "AI_QUOTA_EXCEEDED" };

  if (facts.route)
    return {
      lane: "BYOK",
      connectionId: facts.route.connectionId,
      model: facts.route.model,
    };

  if (facts.subscription) {
    const remaining = subscriptionCredit(facts.subscription, facts.now);
    if (remaining === null)
      return { lane: "NONE", reason: "AI_PROVIDER_NOT_CONFIGURED" };
    // A workspace that chose the managed lane and spent its credit is denied
    // rather than quietly handed the deployment credential — the ceiling it
    // paid for is the whole point of the lane.
    if (remaining <= 0) return { lane: "NONE", reason: "AI_CREDIT_EXHAUSTED" };
    return {
      lane: "MANAGED",
      planCode: facts.subscription.planCode,
      remainingCreditMicrounits: remaining,
    };
  }

  if (facts.deploymentCredentialAllowed) return { lane: "DEPLOYMENT" };
  return { lane: "NONE", reason: "AI_PROVIDER_NOT_CONFIGURED" };
}

/**
 * Which credential a recorded unit of work was charged to. Stored on every
 * usage event so plan credit can be summed apart from a workspace's own spend.
 */
export const AI_USAGE_LANES = ["BYOK", "MANAGED", "DEPLOYMENT"] as const;
export type AiUsageLane = (typeof AI_USAGE_LANES)[number];

/** Tokens for generation and embeddings; milliseconds for transcribed audio. */
export const AI_USAGE_UNIT_KINDS = ["TOKENS", "AUDIO_MS"] as const;
export type AiUsageUnitKind = (typeof AI_USAGE_UNIT_KINDS)[number];

/** HTTP status each denial maps to, so every surface reports it identically. */
export const AI_DENIAL_STATUS: Readonly<Record<AiDenialReason, number>> = {
  AI_DISABLED: 403,
  EXTERNAL_AI_DISABLED: 403,
  AI_QUOTA_EXCEEDED: 429,
  AI_CREDIT_EXHAUSTED: 402,
  AI_PROVIDER_NOT_CONFIGURED: 409,
};
