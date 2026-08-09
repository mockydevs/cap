import { describe, expect, it } from "vitest";
import {
  transcriptLanguageSchema,
  transcriptSearchSchema,
  transcriptSegmentUpdateSchema,
} from "./validation";

describe("transcript API validation", () => {
  it("accepts BCP 47 transcript languages but rejects ambiguous input", () => {
    expect(transcriptLanguageSchema.parse("en-US")).toBe("en-US");
    expect(() => transcriptLanguageSchema.parse("english")).toThrow();
  });

  it("requires meaningful bounded corrections and speaker labels", () => {
    expect(
      transcriptSegmentUpdateSchema.parse({
        text: " Corrected transcript ",
        speakerLabel: "Ada",
        expectedCorrectionRevision: 4,
      }),
    ).toMatchObject({ text: "Corrected transcript", speakerLabel: "Ada" });
    expect(() => transcriptSegmentUpdateSchema.parse({ text: " " })).toThrow();
    expect(() =>
      transcriptSegmentUpdateSchema.parse({
        text: "Valid",
        expectedCorrectionRevision: -1,
      }),
    ).toThrow();
  });

  it("requires a real search term and bounds page size", () => {
    expect(
      transcriptSearchSchema.parse({ q: "incident", limit: "20" }),
    ).toMatchObject({
      q: "incident",
      limit: 20,
    });
    expect(() => transcriptSearchSchema.parse({ q: "x" })).toThrow();
    expect(() =>
      transcriptSearchSchema.parse({ q: "valid", limit: 101 }),
    ).toThrow();
  });
});
