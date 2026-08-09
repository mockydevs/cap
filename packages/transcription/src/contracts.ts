export type TranscriptStatus =
  "REQUESTED" | "PROCESSING" | "READY" | "FAILED" | "DISABLED";
export type TranscriptionRunStatus = "PROCESSING" | "SUCCEEDED" | "FAILED";
export type ConsentBasis = "EXPLICIT" | "WORKSPACE_POLICY" | "NOT_REQUIRED";

export class TranscriptionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionContractError";
  }
}

const transitions: Readonly<
  Record<TranscriptStatus, readonly TranscriptStatus[]>
> = {
  REQUESTED: ["PROCESSING", "DISABLED"],
  PROCESSING: ["READY", "FAILED"],
  READY: ["REQUESTED", "DISABLED"],
  FAILED: ["REQUESTED", "DISABLED"],
  DISABLED: ["REQUESTED"],
};

export function assertTranscriptTransition(
  from: TranscriptStatus,
  to: TranscriptStatus,
): void {
  if (!transitions[from].includes(to)) {
    throw new TranscriptionContractError(
      `Cannot transition transcript from ${from} to ${to}`,
    );
  }
}

export interface ProviderWord {
  readonly providerKey: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly confidence?: number;
}

export interface ProviderSegment {
  readonly providerKey: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speakerLabel?: string;
  readonly confidence?: number;
  readonly words: readonly ProviderWord[];
}

export interface TranscriptionProviderRequest {
  readonly jobId: string;
  readonly audio: AsyncIterable<Uint8Array>;
  readonly mediaType: string;
  readonly language?: string;
  readonly identifySpeakers: boolean;
  readonly consentBasis: ConsentBasis;
}

export interface TranscriptionProviderResult {
  readonly provider: string;
  readonly model: string;
  readonly providerRequestId?: string;
  readonly language: string;
  readonly durationMs: number;
  readonly billedDurationMs?: number;
  readonly costMicrounits?: number;
  readonly currency?: string;
  readonly dataRegion?: string;
  readonly segments: readonly ProviderSegment[];
}

/** Provider adapters receive an audio stream, never object-storage credentials. */
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(
    request: TranscriptionProviderRequest,
  ): Promise<TranscriptionProviderResult>;
}

export function validateProviderResult(
  result: TranscriptionProviderResult,
): void {
  if (
    !result.provider.trim() ||
    !result.model.trim() ||
    !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(result.language)
  ) {
    throw new TranscriptionContractError(
      "Provider provenance or language is invalid",
    );
  }
  if (!Number.isSafeInteger(result.durationMs) || result.durationMs <= 0) {
    throw new TranscriptionContractError(
      "Transcription duration must be a positive integer",
    );
  }
  if (
    (result.costMicrounits === undefined) !==
    (result.currency === undefined)
  ) {
    throw new TranscriptionContractError(
      "Cost and ISO currency must be recorded together",
    );
  }
  if (
    result.costMicrounits !== undefined &&
    (!Number.isSafeInteger(result.costMicrounits) ||
      result.costMicrounits < 0 ||
      !/^[A-Z]{3}$/.test(result.currency!))
  ) {
    throw new TranscriptionContractError("Provider cost is invalid");
  }
  let previousEnd = 0;
  const keys = new Set<string>();
  for (const segment of result.segments) {
    validateTimedText(segment.startMs, segment.endMs, segment.text);
    if (segment.startMs < previousEnd)
      throw new TranscriptionContractError(
        "Provider segments must be ordered and non-overlapping",
      );
    if (!segment.providerKey || keys.has(segment.providerKey))
      throw new TranscriptionContractError(
        "Provider segment keys must be unique",
      );
    keys.add(segment.providerKey);
    previousEnd = segment.endMs;
    let wordEnd = segment.startMs;
    for (const word of segment.words) {
      validateTimedText(word.startMs, word.endMs, word.text);
      if (
        word.startMs < segment.startMs ||
        word.endMs > segment.endMs ||
        word.startMs < wordEnd
      ) {
        throw new TranscriptionContractError(
          "Provider words must be ordered within their segment",
        );
      }
      wordEnd = word.endMs;
    }
  }
}

export function validateTimedText(
  startMs: number,
  endMs: number,
  text: string,
): void {
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    startMs < 0 ||
    endMs <= startMs
  ) {
    throw new TranscriptionContractError(
      "Timed text requires valid increasing millisecond timestamps",
    );
  }
  if (
    !text.trim() ||
    text.length > 10_000 ||
    /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)
  ) {
    throw new TranscriptionContractError(
      "Transcript text is empty, too long, or contains control characters",
    );
  }
}
