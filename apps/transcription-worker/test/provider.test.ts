import { describe, expect, it } from "vitest";
import {
  prepareProviderRunMerge,
  type CanonicalSegment,
} from "@cap/transcription";
import { DeterministicProvider } from "../src/provider";

async function* audio() {
  yield new Uint8Array([1, 2, 3]);
}
describe("worker provider and correction-preserving boundary", () => {
  it("normalizes deterministic provider output into final contracts", async () => {
    const result = await new DeterministicProvider("hello").transcribe({
      jobId: "job-1",
      audio: audio(),
      mediaType: "audio/wav",
      identifySpeakers: false,
      consentBasis: "WORKSPACE_POLICY",
    });
    expect(result).toMatchObject({
      provider: "local-test",
      language: "en",
      durationMs: 1000,
      segments: [
        {
          providerKey: "segment-0",
          text: "hello",
          words: [{ providerKey: "word-0" }],
        },
      ],
    });
  });
  it("prepares an immutable run while retaining corrected text and stable IDs", async () => {
    const previous: CanonicalSegment[] = [
      {
        id: "e48ab34e-d08f-44d3-852d-ece876cced09",
        startMs: 0,
        endMs: 1000,
        providerText: "helo",
        correctedText: "Hello",
        correctedSpeakerLabel: "Ada",
        words: [],
        isOrphaned: false,
      },
    ];
    const result = await new DeterministicProvider("hello world").transcribe({
      jobId: "job-2",
      audio: audio(),
      mediaType: "audio/wav",
      identifySpeakers: false,
      consentBasis: "WORKSPACE_POLICY",
    });
    const command = prepareProviderRunMerge({
      snapshot: {
        transcriptId: "35fbaf33-e1ce-48eb-ab04-d8c9f84bacd4",
        correctionRevision: 4,
        segments: previous,
      },
      provenance: {
        runId: "59a6970b-9f40-471a-aa1a-8bf17f04ac99",
        attempt: 2,
        consentBasis: "WORKSPACE_POLICY",
        consentCapturedAt: new Date("2026-08-09"),
      },
      result,
      ids: { segmentId: () => "new-segment", wordId: () => "new-word" },
    });
    expect(command.expectedCorrectionRevision).toBe(4);
    expect(command.provenance).toMatchObject({
      attempt: 2,
      consentBasis: "WORKSPACE_POLICY",
    });
    expect(command.canonicalSegments[0]).toMatchObject({
      id: previous[0]!.id,
      providerText: "hello world",
      correctedText: "Hello",
      correctedSpeakerLabel: "Ada",
    });
  });
});
