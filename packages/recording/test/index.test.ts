import { describe, expect, it } from "vitest";
import { formatDuration, selectRecorderMimeType } from "../src/index";

describe("recording helpers", () => {
  it("selects the highest-quality compatible mime type", () => {
    expect(
      selectRecorderMimeType((value) => value === "video/webm;codecs=vp8,opus"),
    ).toBe("video/webm;codecs=vp8,opus");
  });

  it("formats capture duration", () => {
    expect(formatDuration(61_999)).toBe("01:01");
  });
});
