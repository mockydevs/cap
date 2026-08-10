import {
  validateTimedText,
  type ProviderSegment,
  type ProviderWord,
} from "./contracts";

export interface CanonicalWord {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly providerText: string;
  readonly correctedText?: string;
  readonly confidence?: number;
  readonly isOrphaned: boolean;
}

export interface CanonicalSegment {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly providerText: string;
  readonly correctedText?: string;
  readonly providerSpeakerLabel?: string;
  readonly correctedSpeakerLabel?: string;
  readonly confidence?: number;
  readonly words: readonly CanonicalWord[];
  readonly isOrphaned: boolean;
}

export interface TranscriptIdFactory {
  segmentId(): string;
  wordId(): string;
}

export function approvedWordText(word: CanonicalWord): string {
  return word.correctedText ?? word.providerText;
}

export function approvedSegmentText(segment: CanonicalSegment): string {
  if (segment.correctedText !== undefined) return segment.correctedText;
  if (segment.words.some((word) => word.correctedText !== undefined)) {
    return segment.words.map(approvedWordText).join(" ");
  }
  return segment.providerText;
}

function normalizedTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function temporalOverlap(
  left: { startMs: number; endMs: number },
  right: { startMs: number; endMs: number },
): number {
  const overlap = Math.max(
    0,
    Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs),
  );
  const union =
    Math.max(left.endMs, right.endMs) - Math.min(left.startMs, right.startMs);
  return union > 0 ? overlap / union : 0;
}

function segmentScore(
  previous: { startMs: number; endMs: number },
  previousTokens: Set<string>,
  next: ProviderSegment,
  nextTokens: Set<string>,
): number {
  const overlap = temporalOverlap(previous, next);
  const midpointDistance = Math.abs(
    (previous.startMs + previous.endMs) / 2 - (next.startMs + next.endMs) / 2,
  );
  if (overlap < 0.2 && midpointDistance > 1_000) return 0;
  const text = tokenSimilarity(previousTokens, nextTokens);
  return overlap * 0.7 + text * 0.3;
}

function hasManualCorrection(segment: CanonicalSegment): boolean {
  return (
    segment.correctedText !== undefined ||
    segment.correctedSpeakerLabel !== undefined ||
    segment.words.some((word) => word.correctedText !== undefined)
  );
}

function mergeWords(
  previous: readonly CanonicalWord[],
  next: readonly ProviderWord[],
  ids: TranscriptIdFactory,
): CanonicalWord[] {
  const unmatched = new Set(previous.map((_, index) => index));
  const merged = next.map((word) => {
    let matchIndex: number | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const index of unmatched) {
      const candidate = previous[index];
      if (!candidate) continue;
      const sameToken =
        candidate.providerText.trim().toLowerCase() ===
        word.text.trim().toLowerCase();
      const distance =
        Math.abs(candidate.startMs - word.startMs) +
        Math.abs(candidate.endMs - word.endMs);
      if ((sameToken || distance <= 500) && distance < bestScore) {
        bestScore = distance;
        matchIndex = index;
      }
    }
    const match = matchIndex === undefined ? undefined : previous[matchIndex];
    if (matchIndex !== undefined) unmatched.delete(matchIndex);
    return {
      id: match?.id ?? ids.wordId(),
      startMs: word.startMs,
      endMs: word.endMs,
      providerText: word.text,
      ...(match?.correctedText !== undefined
        ? { correctedText: match.correctedText }
        : {}),
      ...(word.confidence !== undefined ? { confidence: word.confidence } : {}),
      isOrphaned: false,
    };
  });
  for (const index of unmatched) {
    const word = previous[index];
    if (word?.correctedText !== undefined)
      merged.push({ ...word, isOrphaned: true });
  }
  return merged.sort(
    (left, right) =>
      left.startMs - right.startMs || left.id.localeCompare(right.id),
  );
}

/**
 * Reconciles a new immutable provider run into canonical records. Stable IDs and
 * every manual correction survive; corrected unmatched records remain orphaned
 * instead of being deleted. Uncorrected unmatched provider output is retired.
 */
export function mergeTranscriptPreservingCorrections(
  previous: readonly CanonicalSegment[],
  next: readonly ProviderSegment[],
  ids: TranscriptIdFactory,
): CanonicalSegment[] {
  for (const segment of next)
    validateTimedText(segment.startMs, segment.endMs, segment.text);
  const unmatched = new Set(previous.map((_, index) => index));
  const previousTokens = previous.map((segment) =>
    normalizedTokens(segment.providerText),
  );
  const merged: CanonicalSegment[] = [...next]
    .sort(
      (left, right) =>
        left.startMs - right.startMs ||
        left.providerKey.localeCompare(right.providerKey),
    )
    .map((segment) => {
      const segmentTokens = normalizedTokens(segment.text);
      let matchIndex: number | undefined;
      let best = 0;
      for (const index of unmatched) {
        const candidate = previous[index];
        if (!candidate) continue;
        const score = segmentScore(
          candidate,
          previousTokens[index]!,
          segment,
          segmentTokens,
        );
        if (
          score > best ||
          (score === best &&
            matchIndex !== undefined &&
            candidate.id < previous[matchIndex]!.id)
        ) {
          best = score;
          matchIndex = index;
        }
      }
      if (best < 0.2) matchIndex = undefined;
      const match = matchIndex === undefined ? undefined : previous[matchIndex];
      if (matchIndex !== undefined) unmatched.delete(matchIndex);
      return {
        id: match?.id ?? ids.segmentId(),
        startMs: segment.startMs,
        endMs: segment.endMs,
        providerText: segment.text,
        ...(match?.correctedText !== undefined
          ? { correctedText: match.correctedText }
          : {}),
        ...(segment.speakerLabel !== undefined
          ? { providerSpeakerLabel: segment.speakerLabel }
          : {}),
        ...(match?.correctedSpeakerLabel !== undefined
          ? { correctedSpeakerLabel: match.correctedSpeakerLabel }
          : {}),
        ...(segment.confidence !== undefined
          ? { confidence: segment.confidence }
          : {}),
        words: mergeWords(match?.words ?? [], segment.words, ids),
        isOrphaned: false,
      };
    });
  for (const index of unmatched) {
    const segment = previous[index];
    if (segment && hasManualCorrection(segment))
      merged.push({ ...segment, isOrphaned: true });
  }
  return merged.sort(
    (left, right) =>
      left.startMs - right.startMs || left.id.localeCompare(right.id),
  );
}
