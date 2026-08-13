import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDuration,
  formatViews,
  initialsOf,
} from "./display";

describe("formatViews", () => {
  it("keeps the noun in step with the count", () => {
    expect(formatViews(0)).toBe("0 views");
    expect(formatViews(1)).toBe("1 view");
    expect(formatViews(2)).toBe("2 views");
  });
});

describe("formatDuration", () => {
  it("pads minutes and seconds", () => {
    expect(formatDuration(4 * 60_000 + 8_000)).toBe("04:08");
  });

  it("adds an hours field only once needed", () => {
    expect(formatDuration(59 * 60_000)).toBe("59:00");
    expect(formatDuration(3_600_000 + 61_000)).toBe("1:01:01");
  });

  it("has nothing to show for a recording that has not been measured", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });
});

describe("formatBytes", () => {
  it("steps up units at each thousand", () => {
    expect(formatBytes(12_000)).toBe("12 KB");
    expect(formatBytes(2_400_000)).toBe("2.4 MB");
    expect(formatBytes(7_600_000_000)).toBe("7.6 GB");
  });

  it("reads as empty rather than unknown when nothing is stored", () => {
    expect(formatBytes(null)).toBe("0 MB");
  });
});

describe("initialsOf", () => {
  it("takes the first letter of the first two words", () => {
    expect(initialsOf("Jordan Rivera Diaz")).toBe("JR");
  });

  it("falls back rather than rendering an empty tile", () => {
    expect(initialsOf("   ")).toBe("?");
  });
});
