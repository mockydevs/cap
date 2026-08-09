import { editorDocumentV2Schema, type EditorDocumentV2 } from "./model";

/** Creates revision zero only from authoritative READY recording metadata. */
export function initializeEditorDocument(input: {
  readonly status: "READY";
  readonly recordingId: string;
  readonly sourceAssetId: string;
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate?: number;
}): EditorDocumentV2 {
  if (
    !Number.isSafeInteger(input.durationMs) ||
    input.durationMs <= 0 ||
    !Number.isInteger(input.width) ||
    input.width <= 0 ||
    !Number.isInteger(input.height) ||
    input.height <= 0
  ) {
    throw new Error(
      "READY recording metadata is required to initialize an editor project",
    );
  }
  const transform = {
    x: 0,
    y: 0,
    width: input.width,
    height: input.height,
    rotationDegrees: 0,
    opacity: 1,
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
    zoomKeyframes: [],
  };
  const audio = {
    muted: false,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    noiseReduction: false,
    gainAutomation: [],
  };
  return editorDocumentV2Schema.parse({
    schemaVersion: 2,
    recordingId: input.recordingId,
    sourceAssetIds: [input.sourceAssetId],
    timelineDurationMs: input.durationMs,
    tracks: [
      {
        id: "track_video_primary",
        kind: "VIDEO",
        name: "Video",
        order: 0,
        muted: false,
        locked: false,
      },
      {
        id: "track_audio_primary",
        kind: "AUDIO",
        name: "Audio",
        order: 1,
        muted: false,
        locked: false,
      },
      {
        id: "track_overlays",
        kind: "OVERLAY",
        name: "Overlays",
        order: 2,
        muted: false,
        locked: false,
      },
      {
        id: "track_captions",
        kind: "CAPTION",
        name: "Captions",
        order: 3,
        muted: false,
        locked: false,
      },
    ],
    clips: [
      {
        id: "clip_video_primary",
        trackId: "track_video_primary",
        assetId: input.sourceAssetId,
        sourceStartMs: 0,
        sourceEndMs: input.durationMs,
        timelineStartMs: 0,
        playbackRate: 1,
        transform,
        audio,
      },
    ],
    overlays: [],
    captionStyle: {
      enabled: false,
      fontFamily: "sans-serif",
      fontSize: 48,
      textColor: "#FFFFFF",
      backgroundColor: "#000000CC",
      position: "BOTTOM",
      maxLines: 2,
      burnIn: false,
    },
    canvas: {
      width: input.width,
      height: input.height,
      frameRate: input.frameRate ?? 30,
      background: { kind: "COLOR", color: "#000000" },
      padding: 0,
      borderRadius: 0,
      shadow: { enabled: false, blur: 0, x: 0, y: 0, color: "#00000000" },
    },
  });
}
