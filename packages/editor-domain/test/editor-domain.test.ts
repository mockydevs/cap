import { describe, expect, it } from "vitest";
import {
  applyEditorCommand,
  compileRenderManifest,
  createEditorHistory,
  editorDocumentV2Schema,
  executeEditorCommand,
  initializeEditorDocument,
  nextEditorRevision,
  parseAndMigrateEditDocument,
  redoEditorCommand,
  stableSerializeRenderManifest,
  undoEditorCommand,
  type EditorDocumentV2,
} from "../src/index";

function document(): EditorDocumentV2 {
  return editorDocumentV2Schema.parse({
    schemaVersion: 2,
    recordingId: "recording_1",
    sourceAssetIds: ["asset_b", "asset_a"],
    timelineDurationMs: 10_000,
    tracks: [
      {
        id: "video_1",
        kind: "VIDEO",
        name: "Video",
        order: 0,
        muted: false,
        locked: false,
      },
      {
        id: "audio_1",
        kind: "AUDIO",
        name: "Audio",
        order: 1,
        muted: false,
        locked: false,
      },
      {
        id: "overlay_1",
        kind: "OVERLAY",
        name: "Overlay",
        order: 2,
        muted: false,
        locked: false,
      },
      {
        id: "caption_1",
        kind: "CAPTION",
        name: "Captions",
        order: 3,
        muted: false,
        locked: false,
      },
    ],
    clips: [
      {
        id: "clip_video",
        trackId: "video_1",
        assetId: "asset_b",
        sourceStartMs: 0,
        sourceEndMs: 5_000,
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
      {
        id: "clip_audio",
        trackId: "audio_1",
        assetId: "asset_a",
        sourceStartMs: 0,
        sourceEndMs: 5_000,
        timelineStartMs: 0,
        playbackRate: 1,
        transform: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          rotationDegrees: 0,
          opacity: 1,
          crop: { top: 0, right: 0, bottom: 0, left: 0 },
          zoomKeyframes: [],
        },
        audio: {
          muted: false,
          gainDb: -3,
          fadeInMs: 100,
          fadeOutMs: 100,
          noiseReduction: true,
          gainAutomation: [],
        },
      },
    ],
    overlays: [
      {
        id: "title_1",
        trackId: "overlay_1",
        kind: "TEXT",
        startMs: 0,
        endMs: 2_000,
        x: 100,
        y: 100,
        width: 800,
        height: 100,
        opacity: 1,
        zIndex: 1,
        text: "Hello",
        color: "#FFFFFF",
        fontSize: 48,
      },
    ],
    captionStyle: {
      enabled: true,
      fontFamily: "sans-serif",
      fontSize: 48,
      textColor: "#FFFFFF",
      backgroundColor: "#000000CC",
      position: "BOTTOM",
      maxLines: 2,
      burnIn: false,
    },
    canvas: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      background: { kind: "COLOR", color: "#112233" },
      padding: 0,
      borderRadius: 0,
      shadow: { enabled: false, blur: 0, x: 0, y: 0, color: "#00000000" },
    },
  });
}

describe("versioned edit document", () => {
  it("initializes revision zero from authoritative READY recording metadata", () => {
    const initialized = initializeEditorDocument({
      status: "READY",
      recordingId: "recording_1",
      sourceAssetId: "asset_1",
      durationMs: 12_345,
      width: 1280,
      height: 720,
    });
    expect(initialized).toMatchObject({
      timelineDurationMs: 12_345,
      canvas: { width: 1280, height: 720 },
    });
    expect(initialized.clips).toHaveLength(1);
  });
  it("rejects cross-reference and timeline overlap errors", () => {
    const value = document();
    expect(() =>
      editorDocumentV2Schema.parse({
        ...value,
        clips: [
          ...value.clips,
          { ...value.clips[0]!, id: "overlap", timelineStartMs: 1_000 },
        ],
      }),
    ).toThrow("overlap");
    expect(() =>
      editorDocumentV2Schema.parse({
        ...value,
        clips: [{ ...value.clips[0]!, assetId: "unknown" }],
      }),
    ).toThrow("not declared");
  });

  it("migrates v1 deterministically and validates current documents idempotently", () => {
    const current = document();
    const v1 = {
      schemaVersion: 1,
      recordingId: current.recordingId,
      sourceAssetIds: current.sourceAssetIds,
      timelineDurationMs: current.timelineDurationMs,
      tracks: current.tracks,
      clips: current.clips,
      overlays: current.overlays,
      backgroundColor: "#ABCDEF",
    };
    const migrated = parseAndMigrateEditDocument(v1);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.canvas.background).toEqual({
      kind: "COLOR",
      color: "#ABCDEF",
    });
    expect(parseAndMigrateEditDocument(migrated)).toEqual(migrated);
  });
});

describe("reversible editor commands", () => {
  it("applies an edit and returns an exact inverse", () => {
    const before = document();
    const next = { ...before.clips[0]!, timelineStartMs: 1_000 };
    const applied = applyEditorCommand(before, {
      type: "REPLACE_CLIP",
      clipId: before.clips[0]!.id,
      next,
    });
    expect(applied.document.clips[0]?.timelineStartMs).toBe(1_000);
    expect(
      applyEditorCommand(applied.document, applied.inverse).document,
    ).toEqual(before);
  });

  it("supports deterministic undo, redo, and redo invalidation", () => {
    const before = document();
    const without = executeEditorCommand(createEditorHistory(before), {
      type: "REMOVE_OVERLAY",
      overlayId: before.overlays[0]!.id,
    });
    expect(without.document.overlays).toHaveLength(0);
    const undone = undoEditorCommand(without);
    expect(undone.document).toEqual(before);
    expect(redoEditorCommand(undone).document.overlays).toHaveLength(0);
    expect(
      executeEditorCommand(undone, {
        type: "SET_CANVAS",
        canvas: { ...before.canvas, frameRate: 60 },
      }).redoStack,
    ).toEqual([]);
  });
});

describe("revision and rendering invariants", () => {
  it("enforces optimistic revision comparisons", () => {
    expect(nextEditorRevision(4, 4)).toBe(5);
    expect(() => nextEditorRevision(4, 3)).toThrow("reload");
  });

  it("compiles stable input and layer ordering", () => {
    const first = compileRenderManifest(document());
    const reordered = document();
    const second = compileRenderManifest(
      editorDocumentV2Schema.parse({
        ...reordered,
        sourceAssetIds: [...reordered.sourceAssetIds].reverse(),
        clips: [...reordered.clips].reverse(),
      }),
    );
    expect(first.inputs.map((input) => input.assetId)).toEqual([
      "asset_a",
      "asset_b",
    ]);
    expect(stableSerializeRenderManifest(first)).toBe(
      stableSerializeRenderManifest(second),
    );
    expect(JSON.parse(stableSerializeRenderManifest(first))).toMatchObject({
      manifestVersion: 1,
      output: { videoCodec: "libx264", fastStart: true },
    });
  });
});
