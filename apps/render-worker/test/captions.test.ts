import { describe, expect, it } from "vitest";
import { buildForceStyle, generateSrt, toAssColor } from "../src/captions";

describe("generateSrt", () => {
  it("numbers cues and formats SRT timestamps", () => {
    const srt = generateSrt([
      { startMs: 0, endMs: 1_500, text: "hello" },
      { startMs: 1_500, endMs: 3_000, text: "world" },
    ]);
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nhello\n\n2\n00:00:01,500 --> 00:00:03,000\nworld\n",
    );
  });

  it("drops empty or non-increasing cues", () => {
    expect(generateSrt([{ startMs: 1_000, endMs: 1_000, text: "x" }])).toBe("");
    expect(generateSrt([{ startMs: 0, endMs: 1_000, text: "   " }])).toBe("");
  });
});

describe("toAssColor", () => {
  it("converts RGB and inverts alpha (web opaque -> ass opaque=00)", () => {
    expect(toAssColor("#112233")).toBe("&H00332211&");
  });
  it("inverts a translucent alpha", () => {
    // web AA=0x80 (~50% opaque) -> ass alpha = 255-128 = 127 = 0x7F
    expect(toAssColor("#11223380")).toBe("&H7F332211&");
  });
});

describe("buildForceStyle", () => {
  it("maps caption position to libass numpad alignment", () => {
    const style = {
      enabled: true,
      fontFamily: "Arial",
      fontSize: 32,
      textColor: "#FFFFFF",
      backgroundColor: "#000000CC",
      position: "BOTTOM" as const,
      maxLines: 2,
      burnIn: true,
    };
    expect(buildForceStyle(style)).toContain("Alignment=2");
    expect(buildForceStyle({ ...style, position: "TOP" })).toContain(
      "Alignment=8",
    );
    expect(buildForceStyle({ ...style, position: "CENTER" })).toContain(
      "Alignment=5",
    );
    expect(buildForceStyle(style)).toContain("FontName=Arial");
    expect(buildForceStyle(style)).toContain("FontSize=32");
  });
});
