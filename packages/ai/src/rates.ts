/**
 * Provider price list, expressed in microunits — USD x 10^-6, the same unit as
 * every `cost_microunits` column and the workspace monthly ceiling.
 *
 * These rates answer one question: what did this unit of work cost? A
 * workspace paying with its own key needs an honest number to read its spend
 * against its ceiling; a workspace on a Cap plan needs one to decrement
 * credit. A single blended rate can do neither once the workspace picks its
 * own provider and model, so the rate is resolved per (provider, model).
 *
 * List prices drift, and a workspace can route to a model Cap has never heard
 * of. `unknownTokenRateFromEnvironment` keeps the pre-existing
 * `AI_*_COST_MICROUNITS_PER_MILLION` variables meaningful as the fallback for
 * exactly that case, so an operator can correct an estimate without waiting
 * for a release.
 */

export interface TokenRate {
  /** Cost of one million input (prompt) tokens. */
  readonly inputMicrounitsPerMillion: number;
  /** Cost of one million output (completion) tokens. */
  readonly outputMicrounitsPerMillion: number;
}

export interface AudioRate {
  /** Cost of one minute of transcribed audio. */
  readonly microunitsPerMinute: number;
}

const dollarsPerMillion = (input: number, output: number): TokenRate => ({
  inputMicrounitsPerMillion: Math.round(input * 1_000_000),
  outputMicrounitsPerMillion: Math.round(output * 1_000_000),
});

const dollarsPerMinute = (rate: number): AudioRate => ({
  microunitsPerMinute: Math.round(rate * 1_000_000),
});

/**
 * Keyed by the model identifier a provider reports, lowercased. Lookup also
 * accepts dated and prefixed variants (`gpt-4o-2024-08-06`,
 * `anthropic.claude-opus-5`) — see `resolveTokenRate`.
 */
const TOKEN_RATES: Readonly<Record<string, TokenRate>> = {
  // OpenAI chat models.
  "gpt-5": dollarsPerMillion(1.25, 10),
  "gpt-5-mini": dollarsPerMillion(0.25, 2),
  "gpt-5-nano": dollarsPerMillion(0.05, 0.4),
  "gpt-4.1": dollarsPerMillion(2, 8),
  "gpt-4.1-mini": dollarsPerMillion(0.4, 1.6),
  "gpt-4.1-nano": dollarsPerMillion(0.1, 0.4),
  "gpt-4o": dollarsPerMillion(2.5, 10),
  "gpt-4o-mini": dollarsPerMillion(0.15, 0.6),
  // OpenAI embedding models bill input only.
  "text-embedding-3-small": dollarsPerMillion(0.02, 0),
  "text-embedding-3-large": dollarsPerMillion(0.13, 0),
  // Anthropic Claude models.
  "claude-fable-5": dollarsPerMillion(10, 50),
  "claude-opus-5": dollarsPerMillion(5, 25),
  "claude-opus-4-8": dollarsPerMillion(5, 25),
  "claude-opus-4-7": dollarsPerMillion(5, 25),
  "claude-opus-4-6": dollarsPerMillion(5, 25),
  "claude-sonnet-5": dollarsPerMillion(3, 15),
  "claude-sonnet-4-6": dollarsPerMillion(3, 15),
  "claude-haiku-4-5": dollarsPerMillion(1, 5),
};

const AUDIO_RATES: Readonly<Record<string, AudioRate>> = {
  "gpt-4o-mini-transcribe": dollarsPerMinute(0.003),
  "gpt-4o-transcribe": dollarsPerMinute(0.006),
  "whisper-1": dollarsPerMinute(0.006),
};

/**
 * Priced above every model in the table. An unknown model must not read as
 * cheap: the estimate feeds a spend ceiling and a prepaid credit balance, and
 * both fail safely by over-counting and unsafely by under-counting.
 */
export const CONSERVATIVE_TOKEN_RATE: TokenRate = dollarsPerMillion(10, 50);
export const CONSERVATIVE_AUDIO_RATE: AudioRate = dollarsPerMinute(0.01);

/** Deployment identifiers that wrap an otherwise-standard model name. */
const VENDOR_PREFIXES = ["anthropic.", "openai/", "models/", "us.anthropic."];

function normalizeModel(model: string): string {
  const lowered = model.trim().toLowerCase();
  const prefix = VENDOR_PREFIXES.find((candidate) =>
    lowered.startsWith(candidate),
  );
  return prefix ? lowered.slice(prefix.length) : lowered;
}

/**
 * Exact match first, then the longest table key the model name starts with, so
 * a dated or versioned deployment (`gpt-4o-2024-08-06`) prices as its base
 * model instead of falling through to the conservative rate.
 */
function lookup<T>(table: Readonly<Record<string, T>>, model: string) {
  const normalized = normalizeModel(model);
  const exact = table[normalized];
  if (exact) return exact;
  let matched: T | undefined;
  let matchedLength = 0;
  for (const [key, rate] of Object.entries(table))
    if (
      normalized.startsWith(key) &&
      key.length > matchedLength &&
      // Only a separator may follow, so `gpt-5` never claims `gpt-51`.
      /^[-._:@]/.test(normalized.slice(key.length))
    ) {
      matched = rate;
      matchedLength = key.length;
    }
  return matched;
}

export function resolveTokenRate(model: string, fallback?: TokenRate) {
  return lookup(TOKEN_RATES, model) ?? fallback ?? CONSERVATIVE_TOKEN_RATE;
}

export function resolveAudioRate(model: string, fallback?: AudioRate) {
  return lookup(AUDIO_RATES, model) ?? fallback ?? CONSERVATIVE_AUDIO_RATE;
}

/** True when Cap publishes a rate for this model rather than guessing one. */
export function hasPublishedTokenRate(model: string): boolean {
  return lookup(TOKEN_RATES, model) !== undefined;
}

/**
 * The operator's override for models absent from the table. Returns undefined
 * when neither variable is set, so the conservative rate applies.
 */
export function unknownTokenRateFromEnvironment(
  environment: Record<string, string | undefined>,
): TokenRate | undefined {
  const input = Number(environment.AI_INPUT_COST_MICROUNITS_PER_MILLION);
  const output = Number(environment.AI_OUTPUT_COST_MICROUNITS_PER_MILLION);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  if (input < 0 || output < 0) return undefined;
  return {
    inputMicrounitsPerMillion: input,
    outputMicrounitsPerMillion: output,
  };
}

export function estimateTokenCostMicrounits(input: {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly fallback?: TokenRate | undefined;
}): number {
  const rate = resolveTokenRate(input.model, input.fallback);
  return Math.ceil(
    (Math.max(0, input.inputTokens) * rate.inputMicrounitsPerMillion) /
      1_000_000 +
      (Math.max(0, input.outputTokens) * rate.outputMicrounitsPerMillion) /
        1_000_000,
  );
}

export function estimateAudioCostMicrounits(input: {
  readonly model: string;
  readonly durationMs: number;
  readonly fallback?: AudioRate | undefined;
}): number {
  const rate = resolveAudioRate(input.model, input.fallback);
  return Math.ceil(
    (Math.max(0, input.durationMs) / 60_000) * rate.microunitsPerMinute,
  );
}

/**
 * What a workspace on a Cap plan is charged for metered work: provider cost
 * plus the operator's margin. Percent is read as an integer so a deployment
 * cannot accidentally configure a fractional-cent markup that rounds to zero.
 */
export function applyManagedMarkup(
  costMicrounits: number,
  markupPercent: number,
): number {
  const percent = Number.isFinite(markupPercent)
    ? Math.max(0, Math.trunc(markupPercent))
    : 0;
  return Math.ceil(costMicrounits * (1 + percent / 100));
}
