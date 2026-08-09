import { describe, expect, it } from "vitest";
import { toSrt, toWebVtt } from "./format";

const segments = [
  { startMs: 0, endMs: 1_250, text: "Hello --> everyone", speakerLabel: "Ada" },
  { startMs: 3_661_005, endMs: 3_662_006, text: "Next cue" },
];

describe("caption exports", () => {
  it("emits standards-compliant WebVTT with speaker labels and safe cue text", () => {
    expect(toWebVtt(segments)).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.250\nAda: Hello → everyone\n\n01:01:01.005 --> 01:01:02.006\nNext cue\n",
    );
  });

  it("emits numbered SRT cues with comma milliseconds", () => {
    expect(toSrt(segments)).toContain(
      "1\n00:00:00,000 --> 00:00:01,250\nAda: Hello → everyone",
    );
    expect(toSrt(segments)).toContain("2\n01:01:01,005 --> 01:01:02,006");
  });

  it("excludes malformed or empty cues instead of creating invalid subtitle files", () => {
    expect(
      toWebVtt([
        { startMs: 10, endMs: 10, text: "zero duration" },
        { startMs: -1, endMs: 12, text: "negative" },
        { startMs: 20, endMs: 30, text: "  " },
      ]),
    ).toBe("WEBVTT\n");
  });
});
