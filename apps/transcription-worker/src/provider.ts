import { z } from "zod";
import { estimateAudioCostMicrounits, type AudioRate } from "@cap/ai";
import type {
  TranscriptionProvider,
  TranscriptionProviderRequest,
  TranscriptionProviderResult,
} from "@cap/transcription";

const responseSchema = z.object({
  language: z.string().default("en"),
  duration: z.number().positive(),
  segments: z
    .array(
      z.object({
        id: z.number().int(),
        start: z.number(),
        end: z.number(),
        text: z.string(),
        avg_logprob: z.number().optional(),
        words: z
          .array(
            z.object({ word: z.string(), start: z.number(), end: z.number() }),
          )
          .optional(),
      }),
    )
    .default([]),
});
async function bytes(stream: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return new Blob(parts as BlobPart[], { type: "audio/wav" });
}

export class OpenAICompatibleProvider implements TranscriptionProvider {
  readonly name = "openai-compatible";
  constructor(
    private readonly config: {
      baseUrl: string;
      apiKey: string;
      model: string;
      /** Used only for a model Cap publishes no per-minute price for. */
      fallbackRate?: AudioRate | undefined;
    },
  ) {}
  async transcribe(
    request: TranscriptionProviderRequest,
  ): Promise<TranscriptionProviderResult> {
    const form = new FormData();
    form.set("model", this.config.model);
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
    if (request.language) form.set("language", request.language);
    form.set("file", await bytes(request.audio), "audio.wav");
    const response = await fetch(
      `${this.config.baseUrl.replace(/\/$/, "")}/audio/transcriptions`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        body: form,
      },
    );
    if (!response.ok)
      throw new Error(`Transcription provider returned ${response.status}`);
    const parsed = responseSchema.parse(await response.json());
    const durationMs = Math.round(parsed.duration * 1000);
    return {
      provider: this.name,
      model: this.config.model,
      ...(response.headers.get("x-request-id")
        ? { providerRequestId: response.headers.get("x-request-id")! }
        : {}),
      language: parsed.language,
      durationMs,
      // Transcription is billed per minute of audio, so the run records what
      // it cost from the same rate table every other AI purpose is priced on.
      billedDurationMs: durationMs,
      costMicrounits: estimateAudioCostMicrounits({
        model: this.config.model,
        durationMs,
        fallback: this.config.fallbackRate,
      }),
      currency: "USD",
      segments: parsed.segments.map((segment, ordinal) => ({
        providerKey: String(segment.id ?? ordinal),
        startMs: Math.round(segment.start * 1000),
        endMs: Math.round(segment.end * 1000),
        text: segment.text.trim(),
        ...(segment.avg_logprob === undefined
          ? {}
          : {
              confidence: Math.min(
                1,
                Math.max(0, Math.exp(segment.avg_logprob)),
              ),
            }),
        words: (segment.words ?? []).map((word, wordOrdinal) => ({
          providerKey: `${segment.id}:${wordOrdinal}`,
          startMs: Math.round(word.start * 1000),
          endMs: Math.round(word.end * 1000),
          text: word.word.trim(),
        })),
      })),
    };
  }
}
export class DeterministicProvider implements TranscriptionProvider {
  readonly name = "local-test";
  constructor(private readonly text = "Deterministic test transcript") {}
  async transcribe(
    _request: TranscriptionProviderRequest,
  ): Promise<TranscriptionProviderResult> {
    return {
      provider: this.name,
      model: "deterministic-v1",
      language: "en",
      durationMs: 1000,
      segments: [
        {
          providerKey: "segment-0",
          startMs: 0,
          endMs: 1000,
          text: this.text,
          confidence: 1,
          words: [
            { providerKey: "word-0", startMs: 0, endMs: 1000, text: this.text },
          ],
        },
      ],
    };
  }
}
/**
 * Builds a provider from a workspace's own connection. Transcription runs on
 * every recording, so this is the path that decides whether the customer or
 * the operator pays for the platform's largest AI cost.
 */
export function providerFromConnection(input: {
  baseUrl?: string | null;
  apiKey: string;
  model: string;
}): TranscriptionProvider {
  return new OpenAICompatibleProvider({
    baseUrl: input.baseUrl ?? "https://api.openai.com/v1",
    apiKey: input.apiKey,
    model: input.model,
  });
}
export function providerFromEnvironment(): TranscriptionProvider {
  if (
    process.env.TRANSCRIPTION_PROVIDER === "local-test" &&
    process.env.NODE_ENV !== "production"
  )
    return new DeterministicProvider(process.env.TRANSCRIPTION_TEST_TEXT);
  if (process.env.TRANSCRIPTION_PROVIDER === "openai-compatible") {
    const apiKey = process.env.TRANSCRIPTION_API_KEY;
    if (!apiKey) throw new Error("TRANSCRIPTION_API_KEY must be configured");
    return new OpenAICompatibleProvider({
      baseUrl:
        process.env.TRANSCRIPTION_BASE_URL ?? "https://api.openai.com/v1",
      apiKey,
      model: process.env.TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe",
    });
  }
  throw new Error("TRANSCRIPTION_PROVIDER must be openai-compatible");
}
