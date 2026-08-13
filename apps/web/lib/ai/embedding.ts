import { z } from "zod";
import {
  assertSafeOutboundUrl,
  privateHostAllowlist,
} from "@cap/outbound-http";

const responseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int(),
      embedding: z.array(z.number().finite()).min(8),
    }),
  ),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative() }).optional(),
});

export interface EmbeddingCredential {
  readonly baseUrl: string | null;
  readonly apiKey: string;
  readonly model: string;
}

export interface EmbeddingBatch {
  readonly vectors: ReadonlyArray<{
    readonly embedding: number[];
    readonly model: string;
  }>;
  /** Reported by the provider where available, else estimated for metering. */
  readonly inputTokens: number;
}

/** Rough token estimate for providers that omit usage, at ~4 chars per token. */
function estimateTokens(texts: readonly string[]): number {
  return texts.reduce((total, text) => total + Math.ceil(text.length / 4), 0);
}

/**
 * Embeds a batch against the caller-supplied credential.
 *
 * The credential is a parameter rather than an environment read because search
 * indexing is billable work like any other: whoever the entitlement resolver
 * says is paying for this workspace's embeddings is whose key must be used.
 */
export async function embedTexts(
  texts: readonly string[],
  credential: EmbeddingCredential,
): Promise<EmbeddingBatch> {
  if (!texts.length) return { vectors: [], inputTokens: 0 };
  const endpoint = `${(credential.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/embeddings`;
  await assertSafeOutboundUrl(endpoint, {
    allowedPrivateHosts: privateHostAllowlist(
      process.env.OUTBOUND_PRIVATE_HOST_ALLOWLIST,
    ),
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: credential.model,
      input: texts,
      encoding_format: "float",
    }),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Embedding provider returned ${response.status}`);
  const parsed = responseSchema.parse(await response.json());
  const sorted = [...parsed.data].sort((a, b) => a.index - b.index);
  if (sorted.length !== texts.length)
    throw new Error("Embedding provider returned an incomplete batch");
  return {
    vectors: sorted.map((item) => ({
      embedding: item.embedding,
      model: credential.model,
    })),
    inputTokens: parsed.usage?.prompt_tokens ?? estimateTokens(texts),
  };
}

export function cosine(left: number[], right: number[]) {
  if (left.length !== right.length || !left.length) return -1;
  let dot = 0,
    a = 0,
    b = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
    a += left[index]! ** 2;
    b += right[index]! ** 2;
  }
  return a && b ? dot / (Math.sqrt(a) * Math.sqrt(b)) : -1;
}
