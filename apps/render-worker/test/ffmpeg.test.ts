import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FfmpegRenderManifest } from "@cap/editor-domain";
import {
  assertExecutableManifest,
  renderArguments,
  UnsupportedRenderFeatureError,
} from "../src/ffmpeg";

function baseManifest(): FfmpegRenderManifest {
  return {
    manifestVersion: 1,
    editSchemaVersion: 2,
    durationMs: 5_000,
    canvas: {
      width: 1280,
      height: 720,
      frameRate: 30,
      background: { kind: "COLOR", color: "#000000" },
      padding: 0,
      borderRadius: 0,
      shadow: { enabled: false, blur: 0, x: 0, y: 0, color: "#00000000" },
    },
    inputs: [{ index: 0, assetId: "asset_a" as never }],
    video: [
      {
        clipId: "clip_1",
        trackOrder: 0,
        inputIndex: 0,
        sourceStartMs: 0,
        sourceEndMs: 5_000,
        timelineStartMs: 0,
        playbackRate: 1,
        transform: {
          x: 0,
          y: 0,
          width: 1280,
          height: 720,
          rotationDegrees: 0,
          opacity: 1,
          crop: { top: 0, right: 0, bottom: 0, left: 0 },
          zoomKeyframes: [],
        },
      },
    ],
    audio: [],
    overlays: [],
    captions: {
      enabled: false,
      fontFamily: "sans-serif",
      fontSize: 32,
      textColor: "#FFFFFF",
      backgroundColor: "#000000CC",
      position: "BOTTOM",
      maxLines: 2,
      burnIn: false,
    },
    captionCues: [],
    output: {
      container: "mp4",
      videoCodec: "libx264",
      audioCodec: "aac",
      pixelFormat: "yuv420p",
      fastStart: true,
    },
  };
}

const audioSettings = {
  muted: false,
  gainDb: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
  noiseReduction: false,
  gainAutomation: [] as { timeMs: number; value: number }[],
};

describe("manifest execution guard", () => {
  it("accepts a minimal single-clip manifest", () => {
    expect(() => assertExecutableManifest(baseManifest())).not.toThrow();
  });

  it("accepts transform crop/rotate/position/opacity and zoom keyframes", () => {
    const base = baseManifest();
    const manifest: FfmpegRenderManifest = {
      ...base,
      video: [
        {
          ...base.video[0]!,
          transform: {
            x: 100,
            y: 50,
            width: 640,
            height: 360,
            rotationDegrees: 15,
            opacity: 0.5,
            crop: { top: 0.1, right: 0.1, bottom: 0, left: 0 },
            zoomKeyframes: [{ timeMs: 0, scale: 2, x: 0.5, y: 0.5 }],
          },
        },
      ],
    };
    expect(() => assertExecutableManifest(manifest)).not.toThrow();
  });

  it("accepts audio clips with gain, mute, and fades but not automation", () => {
    const manifest: FfmpegRenderManifest = {
      ...baseManifest(),
      audio: [
        {
          clipId: "aclip_1",
          trackOrder: 1,
          inputIndex: 0,
          sourceStartMs: 0,
          sourceEndMs: 5_000,
          timelineStartMs: 0,
          playbackRate: 1,
          settings: { ...audioSettings, gainDb: -6, fadeInMs: 500 },
        },
      ],
    };
    expect(() => assertExecutableManifest(manifest)).not.toThrow();
  });

  it("rejects audio gain automation", () => {
    const manifest: FfmpegRenderManifest = {
      ...baseManifest(),
      audio: [
        {
          clipId: "aclip_1",
          trackOrder: 1,
          inputIndex: 0,
          sourceStartMs: 0,
          sourceEndMs: 5_000,
          timelineStartMs: 0,
          playbackRate: 1,
          settings: {
            ...audioSettings,
            gainAutomation: [{ timeMs: 0, value: 1 }],
          },
        },
      ],
    };
    expect(() => assertExecutableManifest(manifest)).toThrow(
      UnsupportedRenderFeatureError,
    );
  });

  it("rejects audio noise reduction", () => {
    const manifest: FfmpegRenderManifest = {
      ...baseManifest(),
      audio: [
        {
          clipId: "aclip_1",
          trackOrder: 1,
          inputIndex: 0,
          sourceStartMs: 0,
          sourceEndMs: 5_000,
          timelineStartMs: 0,
          playbackRate: 1,
          settings: { ...audioSettings, noiseReduction: true },
        },
      ],
    };
    expect(() => assertExecutableManifest(manifest)).toThrow(
      UnsupportedRenderFeatureError,
    );
  });

  const overlayBase = {
    id: "overlay_1" as never,
    trackId: "overlay_track" as never,
    startMs: 0,
    endMs: 1_000,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    opacity: 1,
    zIndex: 0,
  };

  for (const overlay of [
    { ...overlayBase, kind: "TEXT", text: "hi", color: "#FFFFFF", fontSize: 24 },
    { ...overlayBase, kind: "IMAGE", assetId: "asset_a", fit: "CONTAIN" },
    {
      ...overlayBase,
      kind: "SHAPE",
      shape: "RECTANGLE",
      fillColor: "#FF0000",
      strokeColor: "#000000",
      strokeWidth: 2,
    },
    {
      ...overlayBase,
      kind: "SHAPE",
      shape: "ELLIPSE",
      fillColor: "#FF0000",
      strokeColor: "#000000",
      strokeWidth: 2,
    },
    { ...overlayBase, kind: "BLUR", strength: 10 },
  ] as const)
    it(`accepts a ${overlay.kind}${"shape" in overlay ? `:${overlay.shape}` : ""} overlay`, () => {
      const manifest: FfmpegRenderManifest = {
        ...baseManifest(),
        overlays: [overlay as never],
      };
      expect(() => assertExecutableManifest(manifest)).not.toThrow();
    });

  for (const shape of ["ARROW", "CALLOUT"] as const)
    it(`rejects the ${shape} overlay shape`, () => {
      const manifest: FfmpegRenderManifest = {
        ...baseManifest(),
        overlays: [
          {
            ...overlayBase,
            kind: "SHAPE",
            shape,
            fillColor: "#FF0000",
            strokeColor: "#000000",
            strokeWidth: 2,
          } as never,
        ],
      };
      expect(() => assertExecutableManifest(manifest)).toThrow(
        UnsupportedRenderFeatureError,
      );
    });

  it("rejects a gradient canvas background", () => {
    const base = baseManifest();
    const manifest: FfmpegRenderManifest = {
      ...base,
      canvas: {
        ...base.canvas,
        background: { kind: "GRADIENT", from: "#000000", to: "#FFFFFF", angleDegrees: 0 },
      },
    };
    expect(() => assertExecutableManifest(manifest)).toThrow(
      UnsupportedRenderFeatureError,
    );
  });

  it("rejects canvas padding, radius, and shadow", () => {
    for (const change of [
      { padding: 10 },
      { borderRadius: 10 },
      { shadow: { enabled: true, blur: 5, x: 0, y: 0, color: "#000000" } },
    ]) {
      const base = baseManifest();
      const manifest: FfmpegRenderManifest = {
        ...base,
        canvas: { ...base.canvas, ...change },
      };
      expect(() => assertExecutableManifest(manifest)).toThrow(
        UnsupportedRenderFeatureError,
      );
    }
  });

  it("accepts caption burn-in when cues are provided", () => {
    const base = baseManifest();
    const manifest: FfmpegRenderManifest = {
      ...base,
      captions: { ...base.captions, enabled: true, burnIn: true },
      captionCues: [{ startMs: 0, endMs: 1_000, text: "hello" }],
    };
    expect(() => assertExecutableManifest(manifest)).not.toThrow();
  });

  it("rejects caption burn-in with no cues", () => {
    const base = baseManifest();
    const manifest: FfmpegRenderManifest = {
      ...base,
      captions: { ...base.captions, enabled: true, burnIn: true },
    };
    expect(() => assertExecutableManifest(manifest)).toThrow(
      UnsupportedRenderFeatureError,
    );
  });

  it("rejects timeline gaps between clips", () => {
    const base = baseManifest();
    const manifest: FfmpegRenderManifest = {
      ...base,
      video: [
        { ...base.video[0]!, sourceEndMs: 2_000 },
        { ...base.video[0]!, clipId: "clip_2", timelineStartMs: 3_000 },
      ],
    };
    expect(() => assertExecutableManifest(manifest)).toThrow(
      UnsupportedRenderFeatureError,
    );
  });
});

describe("renderArguments end-to-end graph assembly", () => {
  let workDir: string;

  afterEach(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("assembles a balanced filter_complex for a masked camera overlay and a text overlay", async () => {
    workDir = await mkdtemp(join(tmpdir(), "cap-render-test-"));
    const base = baseManifest();
    const manifest: FfmpegRenderManifest = {
      ...base,
      inputs: [...base.inputs, { index: 1, assetId: "asset_camera" as never }],
      overlays: [
        {
          id: "camera_1" as never,
          trackId: "overlay_track" as never,
          kind: "IMAGE",
          startMs: 0,
          endMs: 5_000,
          x: 900,
          y: 500,
          width: 300,
          height: 300,
          opacity: 1,
          zIndex: 1,
          assetId: "asset_camera" as never,
          fit: "COVER",
          mask: "CIRCLE",
        } as never,
        {
          id: "title_1" as never,
          trackId: "overlay_track" as never,
          kind: "TEXT",
          startMs: 0,
          endMs: 2_000,
          x: 50,
          y: 50,
          width: 600,
          height: 80,
          opacity: 1,
          zIndex: 2,
          text: "Hello & <world>",
          color: "#FFFFFF",
          fontSize: 32,
        } as never,
      ],
    };

    const args = await renderArguments(
      manifest,
      ["/tmp/input-0.mp4", "/tmp/input-1.mp4"],
      join(workDir, "export.mp4"),
      workDir,
    );

    const filterComplexIndex = args.indexOf("-filter_complex");
    expect(filterComplexIndex).toBeGreaterThan(-1);
    const graph = args[filterComplexIndex + 1]!;
    const opens = graph.match(/\(/g)?.length ?? 0;
    const closes = graph.match(/\)/g)?.length ?? 0;
    expect(opens).toBe(closes);
    expect(graph).toContain("geq="); // the circular camera mask
    expect(graph).not.toContain("split=2"); // only a BLUR overlay would need split
  });

  it("writes the overlay text to a file rather than inlining it in the graph", async () => {
    workDir = await mkdtemp(join(tmpdir(), "cap-render-test-"));
    const base = baseManifest();
    const trickyText = "It's a \"quoted\", colon: and comma, test";
    const manifest: FfmpegRenderManifest = {
      ...base,
      overlays: [
        {
          id: "title_1" as never,
          trackId: "overlay_track" as never,
          kind: "TEXT",
          startMs: 0,
          endMs: 2_000,
          x: 50,
          y: 50,
          width: 600,
          height: 80,
          opacity: 1,
          zIndex: 1,
          text: trickyText,
          color: "#FFFFFF",
          fontSize: 32,
        } as never,
      ],
    };

    const args = await renderArguments(
      manifest,
      ["/tmp/input-0.mp4"],
      join(workDir, "export.mp4"),
      workDir,
    );
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    const match = graph.match(/textfile=([^:]+)/);
    expect(match).not.toBeNull();
    const written = await readFile(match![1]!, "utf8");
    expect(written).toBe(trickyText);
  });

  it("adds -loop 1 only for inputs used exclusively by an IMAGE overlay", async () => {
    workDir = await mkdtemp(join(tmpdir(), "cap-render-test-"));
    const base = baseManifest();
    const manifest: FfmpegRenderManifest = {
      ...base,
      inputs: [...base.inputs, { index: 1, assetId: "asset_logo" as never }],
      overlays: [
        {
          id: "logo_1" as never,
          trackId: "overlay_track" as never,
          kind: "IMAGE",
          startMs: 0,
          endMs: 5_000,
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          opacity: 1,
          zIndex: 1,
          assetId: "asset_logo" as never,
          fit: "CONTAIN",
          mask: "NONE",
        } as never,
      ],
    };

    const args = await renderArguments(
      manifest,
      ["/tmp/input-0.mp4", "/tmp/logo.png"],
      join(workDir, "export.mp4"),
      workDir,
    );
    // First input (used by the video clip) must not be looped; the second
    // (used only by the image overlay) must be. Each "-i PATH" pair is
    // preceded by "-loop 1" only when looped, so PATH's own preceding
    // token is always "-i" either way — check two tokens back instead.
    const firstInputIndex = args.indexOf("/tmp/input-0.mp4");
    const secondInputIndex = args.indexOf("/tmp/logo.png");
    expect(args[firstInputIndex - 1]).toBe("-i");
    expect(args[firstInputIndex - 2]).not.toBe("-loop");
    expect(args[secondInputIndex - 1]).toBe("-i");
    expect(args[secondInputIndex - 2]).toBe("1");
    expect(args[secondInputIndex - 3]).toBe("-loop");
  });
});
