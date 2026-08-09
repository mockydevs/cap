import { describe, expect, it } from "vitest";
import { MediaCommandError } from "../src/ffmpeg";

describe("media command errors", () => {
  it("preserves bounded diagnostic output", () => {
    const error = new MediaCommandError("ffmpeg", "invalid source");
    expect(error.message).toContain("ffmpeg failed");
    expect(error.output).toBe("invalid source");
  });
});
