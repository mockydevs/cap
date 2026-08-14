import { describe, expect, it } from "vitest";
import { formatDuration, selectRecorderMimeType } from "../src/index";

describe("recording helpers", () => {
  it("selects the highest-quality compatible mime type", () => {
    expect(
      selectRecorderMimeType((value) => value === "video/webm;codecs=vp8,opus"),
    ).toBe("video/webm;codecs=vp8,opus");
  });

  it("prefers MP4 so the recording is playable without being transcoded", () => {
    expect(selectRecorderMimeType(() => true)).toBe(
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    );
  });

  it("falls back to WebM where MP4 cannot be recorded", () => {
    const webmOnly = (value: string) => value.startsWith("video/webm");
    expect(selectRecorderMimeType(webmOnly)).toBe("video/webm;codecs=vp9,opus");
  });

  it("returns nothing when the browser supports none of them", () => {
    expect(selectRecorderMimeType(() => false)).toBeUndefined();
  });

  it("formats capture duration", () => {
    expect(formatDuration(61_999)).toBe("01:01");
  });
});
