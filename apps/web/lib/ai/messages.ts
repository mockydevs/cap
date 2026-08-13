/**
 * One place where an AI error code becomes something a person can act on.
 *
 * These codes are raised by the entitlement resolver and reach three different
 * surfaces; without a shared mapping each one either invents its own wording or
 * — as the insights panel used to — renders the raw code at the reader.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  AI_DISABLED:
    "AI features are switched off for this workspace. An owner or admin can turn them on in workspace settings.",
  EXTERNAL_AI_DISABLED:
    "This workspace has not approved sending transcripts to an external AI provider.",
  AI_PROVIDER_NOT_CONFIGURED:
    "No AI provider is connected yet. Connect your own API key, or start a plan, to use AI features.",
  AI_CREDIT_EXHAUSTED:
    "This period's included AI credit is spent. Change plan, or connect your own API key, to continue.",
  AI_QUOTA_EXCEEDED:
    "This workspace has reached its monthly AI ceiling. An owner or admin can raise it in workspace settings.",
  AI_CREDENTIAL_ENCRYPTION_UNAVAILABLE:
    "This deployment cannot store provider credentials yet. Ask an operator to configure the AI credential key.",
  AI_QUEUE_NOT_CONFIGURED:
    "AI processing is temporarily unavailable. Try again shortly.",
  AI_PROVIDER_VALIDATION_FAILED:
    "The provider rejected that key or endpoint. Check both and try again.",
  TRANSCRIPT_NOT_READY:
    "This recording has no approved transcript yet, so there is nothing to analyse.",
  FORBIDDEN: "You do not have permission to do that.",
  RATE_LIMITED: "Too many requests. Try again in a moment.",
};

/** Denials an admin can clear by connecting a key or changing the plan. */
const ENTITLEMENT_DENIALS = new Set([
  "AI_DISABLED",
  "EXTERNAL_AI_DISABLED",
  "AI_PROVIDER_NOT_CONFIGURED",
  "AI_CREDIT_EXHAUSTED",
  "AI_QUOTA_EXCEEDED",
]);

export function aiErrorMessage(code: string | undefined): string {
  if (!code) return "That AI request could not be completed.";
  return MESSAGES[code] ?? "That AI request could not be completed.";
}

export function isEntitlementDenial(code: string | undefined): boolean {
  return Boolean(code && ENTITLEMENT_DENIALS.has(code));
}

/** Shape returned by `GET /api/ai/entitlement` for one purpose. */
export type PurposeEntitlement =
  | { lane: "BYOK"; connectionId: string; model: string }
  | { lane: "MANAGED"; planCode: string; remainingCreditMicrounits: number }
  | { lane: "DEPLOYMENT" }
  | { lane: "NONE"; reason: string };

export type WorkspaceEntitlements = {
  analysis: PurposeEntitlement;
  embeddings: PurposeEntitlement;
  transcription: PurposeEntitlement;
};

/** Short label for who pays, shown next to each purpose in settings. */
export function laneLabel(entitlement: PurposeEntitlement): string {
  switch (entitlement.lane) {
    case "BYOK":
      return "Your provider key";
    case "MANAGED":
      return "Your Cap plan";
    case "DEPLOYMENT":
      return "This deployment";
    default:
      return "Unavailable";
  }
}

/** Microunits are USD x 10^-6; spend is only ever shown to two decimals. */
export function formatMicrounits(value: number): string {
  return `$${(value / 1_000_000).toFixed(2)}`;
}
