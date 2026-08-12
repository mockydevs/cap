import { describe, expect, it } from "vitest";
import {
  approvedSegmentText,
  assertTranscriptTransition,
  formatCaptionTimestamp,
  mergeTranscriptPreservingCorrections,
  prepareProviderRunMerge,
  validateProviderResult,
  type CanonicalSegment,
  type TranscriptIdFactory,
} from "../src/index";

function idFactory(): TranscriptIdFactory {
  let segment = 0;
  let word = 0;
  return {
    segmentId: () => `new-segment-${++segment}`,
    wordId: () => `new-word-${++word}`,
  };
}

const previous: CanonicalSegment[] = [
  {
    id: "stable-segment",
    startMs: 0,
    endMs: 2_000,
    providerText: "hello world",
    correctedText: "Hello, world!",
    providerSpeakerLabel: "speaker_0",
    correctedSpeakerLabel: "Ada",
    words: [
      {
        id: "stable-word-1",
        startMs: 0,
        endMs: 600,
        providerText: "hello",
        correctedText: "Hello,",
        isOrphaned: false,
      },
      {
        id: "stable-word-2",
        startMs: 700,
        endMs: 1_300,
        providerText: "world",
        isOrphaned: false,
      },
    ],
    isOrphaned: false,
  },
];

describe("correction-preserving transcript merge", () => {
  it("updates provider output while preserving stable IDs and every manual correction", () => {
    const merged = mergeTranscriptPreservingCorrections(
      previous,
      [
        {
          providerKey: "provider-new-1",
          startMs: 50,
          endMs: 2_100,
          text: "hello brave world",
          speakerLabel: "speaker_1",
          words: [
            { providerKey: "w1", startMs: 50, endMs: 650, text: "hello" },
            { providerKey: "w2", startMs: 700, endMs: 1_000, text: "brave" },
            { providerKey: "w3", startMs: 1_100, endMs: 1_700, text: "world" },
          ],
        },
      ],
      idFactory(),
    );
    expect(merged[0]).toMatchObject({
      id: "stable-segment",
      providerText: "hello brave world",
      correctedText: "Hello, world!",
      correctedSpeakerLabel: "Ada",
      isOrphaned: false,
    });
    expect(
      merged[0]?.words.find((word) => word.id === "stable-word-1")
        ?.correctedText,
    ).toBe("Hello,");
    expect(approvedSegmentText(merged[0]!)).toBe("Hello, world!");
  });

  it("retains corrected content as orphaned when a provider drops it", () => {
    const merged = mergeTranscriptPreservingCorrections(
      previous,
      [],
      idFactory(),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "stable-segment",
      correctedText: "Hello, world!",
      isOrphaned: true,
    });
  });

  it("retires unmatched uncorrected provider output", () => {
    const {
      correctedText: _text,
      correctedSpeakerLabel: _speaker,
      ...base
    } = previous[0]!;
    const uncorrected: CanonicalSegment[] = [{ ...base, words: [] }];
    expect(
      mergeTranscriptPreservingCorrections(uncorrected, [], idFactory()),
    ).toEqual([]);
  });

  it("binds a merge to the loaded correction revision and explicit consent actor", () => {
    expect(() =>
      prepareProviderRunMerge({
        snapshot: {
          transcriptId: "transcript-1",
          correctionRevision: 7,
          segments: previous,
        },
        provenance: {
          runId: "run-1",
          attempt: 2,
          consentBasis: "EXPLICIT",
          consentCapturedAt: new Date(),
        },
        result: {
          provider: "speech",
          model: "v1",
          language: "en",
          durationMs: 2_000,
          segments: [],
        },
        ids: idFactory(),
      }),
    ).toThrow("requires an actor");
    const command = prepareProviderRunMerge({
      snapshot: {
        transcriptId: "transcript-1",
        correctionRevision: 7,
        segments: previous,
      },
      provenance: {
        runId: "run-1",
        attempt: 2,
        consentBasis: "EXPLICIT",
        consentCapturedAt: new Date(),
        consentActorUserId: "user-1",
      },
      result: {
        provider: "speech",
        model: "v1",
        language: "en",
        durationMs: 2_000,
        segments: [],
      },
      ids: idFactory(),
    });
    expect(command.expectedCorrectionRevision).toBe(7);
    expect(command.canonicalSegments[0]).toMatchObject({
      id: "stable-segment",
      isOrphaned: true,
    });
  });
});

describe("transcription contracts and captions", () => {
  it("enforces the transcript lifecycle", () => {
    expect(() =>
      assertTranscriptTransition("REQUESTED", "PROCESSING"),
    ).not.toThrow();
    expect(() => assertTranscriptTransition("READY", "PROCESSING")).toThrow(
      "Cannot transition",
    );
  });

  it("requires complete provider provenance and cost", () => {
    expect(() =>
      validateProviderResult({
        provider: "speech",
        model: "v1",
        language: "en",
        durationMs: 2_000,
        costMicrounits: 12,
        segments: [],
      }),
    ).toThrow("Cost and ISO currency");
  });

  it("formats cue timestamps for both subtitle dialects", () => {
    expect(formatCaptionTimestamp(0, ".")).toBe("00:00:00.000");
    expect(formatCaptionTimestamp(3_661_005, ",")).toBe("01:01:01,005");
    expect(formatCaptionTimestamp(-5, ",")).toBe("00:00:00,000");
  });
});
