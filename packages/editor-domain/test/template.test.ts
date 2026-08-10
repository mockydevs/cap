import { describe, expect, it } from "vitest";
import {
  applyTemplate,
  captureTemplateFragment,
  editorDocumentV2Schema,
  editorTemplateFragmentSchema,
  initializeEditorDocument,
  type EditorDocumentV2,
  type TemplateIdFactory,
} from "../src/index";

function project(): EditorDocumentV2 {
  return initializeEditorDocument({
    status: "READY",
    recordingId: "recording_1",
    sourceAssetId: "asset_main",
    durationMs: 10_000,
    width: 1920,
    height: 1080,
  });
}

function introFragment() {
  return editorTemplateFragmentSchema.parse({
    sourceAssetIds: ["asset_intro"],
    durationMs: 2_000,
    clips: [
      {
        id: "intro_clip",
        trackId: "track_video_primary",
        assetId: "asset_intro",
        sourceStartMs: 0,
        sourceEndMs: 2_000,
        timelineStartMs: 0,
        playbackRate: 1,
        transform: {
          x: 0,
          y: 0,
          width: 1920,
          height: 1080,
          rotationDegrees: 0,
          opacity: 1,
          crop: { top: 0, right: 0, bottom: 0, left: 0 },
          zoomKeyframes: [],
        },
        audio: {
          muted: false,
          gainDb: 0,
          fadeInMs: 0,
          fadeOutMs: 0,
          noiseReduction: false,
          gainAutomation: [],
        },
      },
    ],
    overlays: [
      {
        id: "intro_title",
        trackId: "track_overlays",
        kind: "TEXT",
        startMs: 0,
        endMs: 2_000,
        x: 100,
        y: 100,
        width: 800,
        height: 100,
        opacity: 1,
        zIndex: 1,
        text: "Welcome",
        color: "#FFFFFF",
        fontSize: 48,
      },
    ],
  });
}

let counter = 0;
function ids(): TemplateIdFactory {
  return {
    clipId: () => `clip_${(counter += 1)}` as never,
    overlayId: () => `overlay_${(counter += 1)}` as never,
  };
}

describe("editorTemplateFragmentSchema", () => {
  it("rejects a clip referencing an asset the fragment doesn't declare", () => {
    expect(() =>
      editorTemplateFragmentSchema.parse({
        sourceAssetIds: ["asset_a"],
        durationMs: 1_000,
        clips: [
          {
            id: "c1",
            trackId: "track_video_primary",
            assetId: "asset_b",
            sourceStartMs: 0,
            sourceEndMs: 1_000,
            timelineStartMs: 0,
            playbackRate: 1,
            transform: {
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              rotationDegrees: 0,
              opacity: 1,
              crop: { top: 0, right: 0, bottom: 0, left: 0 },
              zoomKeyframes: [],
            },
            audio: {
              muted: false,
              gainDb: 0,
              fadeInMs: 0,
              fadeOutMs: 0,
              noiseReduction: false,
              gainAutomation: [],
            },
          },
        ],
        overlays: [],
      }),
    ).toThrow();
  });

  it("rejects a clip that exceeds the declared duration", () => {
    const fragment = introFragment();
    expect(() =>
      editorTemplateFragmentSchema.parse({
        ...fragment,
        durationMs: 500,
      }),
    ).toThrow();
  });
});

describe("captureTemplateFragment", () => {
  it("captures a project's current timeline as a fragment", () => {
    const document = project();
    const fragment = captureTemplateFragment(document);
    expect(fragment.durationMs).toBe(document.timelineDurationMs);
    expect(fragment.clips).toEqual(document.clips);
    expect(fragment.sourceAssetIds).toEqual(document.sourceAssetIds);
  });
});

describe("applyTemplate", () => {
  it("prepends an intro, shifting existing content and extending duration", () => {
    const document = project();
    const fragment = introFragment();
    const result = applyTemplate(document, fragment, "INTRO", ids());

    expect(result.timelineDurationMs).toBe(12_000);
    expect(result.sourceAssetIds).toEqual(
      expect.arrayContaining(["asset_main", "asset_intro"]),
    );
    const shiftedMainClip = result.clips.find(
      (clip) => clip.assetId === "asset_main",
    );
    expect(shiftedMainClip?.timelineStartMs).toBe(2_000);
    const introClip = result.clips.find((clip) => clip.assetId === "asset_intro");
    expect(introClip?.timelineStartMs).toBe(0);
    const introTitle = result.overlays.find((o) => o.kind === "TEXT");
    expect(introTitle).toMatchObject({ startMs: 0, endMs: 2_000 });

    editorDocumentV2Schema.parse(result); // no gaps/overlaps, no dangling asset refs
  });

  it("appends an outro after everything else", () => {
    const document = project();
    const fragment = introFragment();
    const result = applyTemplate(document, fragment, "OUTRO", ids());

    expect(result.timelineDurationMs).toBe(12_000);
    const mainClip = result.clips.find((clip) => clip.assetId === "asset_main");
    expect(mainClip?.timelineStartMs).toBe(0);
    const outroClip = result.clips.find((clip) => clip.assetId === "asset_intro");
    expect(outroClip?.timelineStartMs).toBe(10_000);

    editorDocumentV2Schema.parse(result);
  });

  it("mints fresh IDs so the same template can be applied twice without collisions", () => {
    const document = project();
    const fragment = introFragment();
    const once = applyTemplate(document, fragment, "INTRO", ids());
    const twice = applyTemplate(once, fragment, "INTRO", ids());

    const clipIds = twice.clips.map((clip) => clip.id);
    expect(new Set(clipIds).size).toBe(clipIds.length);
    editorDocumentV2Schema.parse(twice);
  });
});
