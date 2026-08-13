import {
  validateProviderResult,
  validateTimedText,
  type ConsentBasis,
  type TranscriptionProviderResult,
} from "./contracts";
import {
  mergeTranscriptPreservingCorrections,
  type CanonicalSegment,
  type TranscriptIdFactory,
} from "./merge";

export interface CanonicalTranscriptSnapshot {
  readonly transcriptId: string;
  readonly correctionRevision: number;
  readonly segments: readonly CanonicalSegment[];
}

export interface ProviderRunProvenance {
  readonly runId: string;
  readonly attempt: number;
  readonly consentBasis: ConsentBasis;
  readonly consentCapturedAt: Date;
  readonly consentActorUserId?: string;
}

export interface MergedProviderRun {
  readonly transcriptId: string;
  readonly expectedCorrectionRevision: number;
  readonly provenance: ProviderRunProvenance;
  readonly providerResult: TranscriptionProviderResult;
  readonly canonicalSegments: readonly CanonicalSegment[];
}

/**
 * The adapter must atomically insert the immutable provider run and replace only
 * provider-owned canonical fields using expectedCorrectionRevision as a CAS.
 * Corrected fields, correction versions, correctedBy and correctedAt may never
 * be overwritten by provider data.
 */
export interface TranscriptPersistence<Transaction = unknown> {
  loadCanonical(transcriptId: string): Promise<CanonicalTranscriptSnapshot>;
  /**
   * `onCommit` receives the adapter's own transaction handle and must run
   * inside the same atomic unit as the run. Callers use it to record metered
   * usage, which must neither survive a rolled-back transcription nor be lost
   * after a committed one. The handle's type is the adapter's to decide, so
   * this contract stays free of any particular database driver.
   */
  commitMergedProviderRun(
    command: MergedProviderRun,
    onCommit?: (transaction: Transaction) => Promise<void>,
  ): Promise<void>;
  applySegmentCorrection(command: {
    transcriptId: string;
    segmentId: string;
    expectedSegmentCorrectionVersion: number;
    expectedTranscriptCorrectionRevision: number;
    correctedText?: string;
    correctedSpeakerLabel?: string;
    correctedBy: string;
    correctedAt: Date;
  }): Promise<void>;
}

export function prepareProviderRunMerge(input: {
  readonly snapshot: CanonicalTranscriptSnapshot;
  readonly provenance: ProviderRunProvenance;
  readonly result: TranscriptionProviderResult;
  readonly ids: TranscriptIdFactory;
}): MergedProviderRun {
  validateProviderResult(input.result);
  if (
    !Number.isInteger(input.provenance.attempt) ||
    input.provenance.attempt < 1
  ) {
    throw new Error("Transcription attempt must be positive");
  }
  if (
    input.provenance.consentBasis === "EXPLICIT" &&
    !input.provenance.consentActorUserId
  ) {
    throw new Error("Explicit transcription consent requires an actor");
  }
  return {
    transcriptId: input.snapshot.transcriptId,
    expectedCorrectionRevision: input.snapshot.correctionRevision,
    provenance: input.provenance,
    providerResult: input.result,
    canonicalSegments: mergeTranscriptPreservingCorrections(
      input.snapshot.segments,
      input.result.segments,
      input.ids,
    ),
  };
}

export function validateCorrectionPatch(input: {
  readonly correctedText?: string;
  readonly correctedSpeakerLabel?: string;
}): void {
  if (
    input.correctedText === undefined &&
    input.correctedSpeakerLabel === undefined
  ) {
    throw new Error("A correction must change text or speaker label");
  }
  if (input.correctedText !== undefined)
    validateTimedText(0, 1, input.correctedText);
  if (
    input.correctedSpeakerLabel !== undefined &&
    (!input.correctedSpeakerLabel.trim() ||
      input.correctedSpeakerLabel.length > 200)
  ) {
    throw new Error("Corrected speaker label is invalid");
  }
}
