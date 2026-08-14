import { describe, expect, it } from "vitest";
import {
  canRemuxForPlayback,
  durationFromPacketTimeline,
  hlsPackageArguments,
  MediaCommandError,
  playbackEncodeArguments,
  playbackRemuxArguments,
  posterArguments,
} from "../src/ffmpeg";

describe("MediaRecorder duration fallback", () => {
  it("derives duration from the final video packet when WebM metadata is absent", () => {
    expect(
      durationFromPacketTimeline("0.000000,0.033000\n1.966000,0.034000\n"),
    ).toBe(2);
  });

  it("ignores N/A and malformed packet rows", () => {
    expect(durationFromPacketTimeline("N/A,N/A\ninvalid\n2.500000,N/A\n")).toBe(
      2.5,
    );
  });
});

describe("media command errors", () => {
  it("preserves bounded diagnostic output", () => {
    const error = new MediaCommandError("ffmpeg", "invalid source");
    expect(error.message).toContain("ffmpeg failed");
    expect(error.output).toBe("invalid source");
  });
});

describe("playback asset arguments", () => {
  it("encodes the source exactly once, with segment-aligned keyframes", () => {
    const argv = playbackEncodeArguments("/tmp/source.webm", "/tmp/out/pb.mp4");
    expect(argv.filter((value) => value === "-c:v")).toHaveLength(1);
    expect(argv).toContain("libx264");
    expect(argv).toContain("veryfast");
    // Keyframes on the HLS boundary are what make the copy-only package work.
    expect(argv).toContain("expr:gte(t,n_forced*6)");
    expect(argv).toContain("+faststart");
    expect(argv.at(-1)).toBe("/tmp/out/pb.mp4");
  });

  it("remuxes compatible browser MP4 without invoking an encoder", () => {
    expect(
      canRemuxForPlayback({
        videoCodec: "h264",
        audioCodec: "aac",
        container: "mov,mp4,m4a,3gp,3g2,mj2",
      }),
    ).toBe(true);
    const argv = playbackRemuxArguments("/tmp/source", "/tmp/playback.mp4");
    expect(argv).toContain("copy");
    expect(argv).toContain("+faststart");
    expect(argv).not.toContain("libx264");
  });

  it("keeps WebM and incompatible audio on the encode path", () => {
    expect(
      canRemuxForPlayback({
        videoCodec: "vp9",
        audioCodec: "opus",
        container: "matroska,webm",
      }),
    ).toBe(false);
    expect(
      canRemuxForPlayback({
        videoCodec: "h264",
        audioCodec: "opus",
        container: "mov,mp4",
      }),
    ).toBe(false);
  });

  it("packages HLS by copying streams rather than re-encoding", () => {
    const argv = hlsPackageArguments("/tmp/out/pb.mp4", "/tmp/out");
    expect(argv).toContain("copy");
    expect(argv).not.toContain("libx264");
    expect(argv).not.toContain("-crf");
    expect(argv).toContain("/tmp/out/segment-%03d.ts");
    expect(argv.at(-1)).toBe("/tmp/out/master.m3u8");
  });

  it("takes the poster a second in, and earlier for very short clips", () => {
    expect(posterArguments("/a.mp4", "/p.jpg", 12)).toContain("1.000");
    expect(posterArguments("/a.mp4", "/p.jpg", 0.4)).toContain("0.200");
  });
});
