import { describe, expect, it } from "vitest";
import {
  assertExecutableManifest,
  UnsupportedRenderFeatureError,
} from "../src/ffmpeg";
const base = {
  canvas: {
    width: 1280,
    height: 720,
    background: { kind: "COLOR", color: "#000000" },
  },
  audio: [],
  overlays: [],
  captions: { enabled: false, burnIn: false },
  video: [],
} as Record<string, unknown>;
describe("manifest execution guard", () => {
  for (const [name, change] of [
    ["audio", { audio: [{}] }],
    ["text overlay", { overlays: [{ kind: "TEXT" }] }],
    ["shape overlay", { overlays: [{ kind: "SHAPE" }] }],
    ["blur overlay", { overlays: [{ kind: "BLUR" }] }],
    ["image overlay", { overlays: [{ kind: "IMAGE" }] }],
    ["captions", { captions: { enabled: true, burnIn: true } }],
    [
      "background",
      {
        canvas: { width: 1280, height: 720, background: { kind: "GRADIENT" } },
      },
    ],
  ] as const)
    it(`rejects unsupported ${name} before FFmpeg`, () =>
      expect(() =>
        assertExecutableManifest({ ...base, ...change } as never),
      ).toThrow(UnsupportedRenderFeatureError));
});
