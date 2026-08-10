import {
  editorDocumentV2Schema,
  type AssetId,
  type EditorDocumentV2,
  type Overlay,
} from "./model";

export interface FfmpegRenderManifest {
  readonly manifestVersion: 1;
  readonly editSchemaVersion: 2;
  readonly durationMs: number;
  readonly canvas: EditorDocumentV2["canvas"];
  readonly inputs: readonly {
    readonly index: number;
    readonly assetId: AssetId;
  }[];
  readonly video: readonly {
    readonly clipId: string;
    readonly trackOrder: number;
    readonly inputIndex: number;
    readonly sourceStartMs: number;
    readonly sourceEndMs: number;
    readonly timelineStartMs: number;
    readonly playbackRate: number;
    readonly transform: EditorDocumentV2["clips"][number]["transform"];
  }[];
  readonly audio: readonly {
    readonly clipId: string;
    readonly trackOrder: number;
    readonly inputIndex: number;
    readonly sourceStartMs: number;
    readonly sourceEndMs: number;
    readonly timelineStartMs: number;
    readonly playbackRate: number;
    readonly settings: EditorDocumentV2["clips"][number]["audio"];
  }[];
  readonly overlays: readonly Overlay[];
  readonly captions: EditorDocumentV2["captionStyle"];
  /** Populated by the caller from the approved transcript when captions.burnIn is set. */
  readonly captionCues: readonly {
    readonly startMs: number;
    readonly endMs: number;
    readonly text: string;
  }[];
  readonly output: {
    readonly container: "mp4";
    readonly videoCodec: "libx264";
    readonly audioCodec: "aac";
    readonly pixelFormat: "yuv420p";
    readonly fastStart: true;
  };
}

/**
 * The initial FFmpeg executor intentionally has a narrow capability surface.
 * Keep this guard beside manifest compilation so the API can reject a job
 * before it is persisted or queued, instead of reporting a late worker error.
 */
export class UnsupportedRenderFeatureError extends Error {
  constructor(feature: string) {
    super(`Render feature is not supported: ${feature}`);
    this.name = "UnsupportedRenderFeatureError";
  }
}

/**
 * Deliberate remaining scope boundary: gradient/image canvas backgrounds,
 * canvas padding/shadow/rounded-corners, keyframed audio gain automation,
 * audio noise reduction, and the ARROW/CALLOUT overlay shapes are cosmetic
 * or algorithmically heavy enough that they are not yet implemented by the
 * FFmpeg executor. Everything else the editor domain models is executable.
 */
export function assertExecutableRenderManifest(manifest: FfmpegRenderManifest) {
  if (manifest.canvas.background.kind !== "COLOR")
    throw new UnsupportedRenderFeatureError("canvas background:gradient-or-image");
  if (
    manifest.canvas.padding !== 0 ||
    manifest.canvas.borderRadius !== 0 ||
    manifest.canvas.shadow.enabled
  )
    throw new UnsupportedRenderFeatureError("canvas styling:padding/shadow/radius");
  for (const clip of manifest.audio)
    if (clip.settings.gainAutomation.length || clip.settings.noiseReduction)
      throw new UnsupportedRenderFeatureError(
        "audio:gainAutomation-or-noiseReduction",
      );
  for (const overlay of manifest.overlays)
    if (
      overlay.kind === "SHAPE" &&
      (overlay.shape === "ARROW" || overlay.shape === "CALLOUT")
    )
      throw new UnsupportedRenderFeatureError(`overlay:shape:${overlay.shape}`);
  if (manifest.captions.burnIn && manifest.captionCues.length === 0)
    throw new UnsupportedRenderFeatureError("caption burn-in:no cues provided");
  let cursor = 0;
  for (const clip of manifest.video) {
    if (clip.timelineStartMs !== cursor)
      throw new UnsupportedRenderFeatureError("timeline gaps/overlaps");
    cursor += Math.round(
      (clip.sourceEndMs - clip.sourceStartMs) / clip.playbackRate,
    );
  }
}

export function compileRenderManifest(
  value: EditorDocumentV2,
  captionCues: readonly {
    readonly startMs: number;
    readonly endMs: number;
    readonly text: string;
  }[] = [],
): FfmpegRenderManifest {
  const document = editorDocumentV2Schema.parse(value);
  const tracks = new Map(document.tracks.map((track) => [track.id, track]));
  const assetIds = [...new Set(document.sourceAssetIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  const inputIndex = new Map(
    assetIds.map((assetId, index) => [assetId, index]),
  );
  const sortedClips = [...document.clips].sort((left, right) => {
    const trackDelta =
      tracks.get(left.trackId)!.order - tracks.get(right.trackId)!.order;
    return (
      trackDelta ||
      left.timelineStartMs - right.timelineStartMs ||
      left.id.localeCompare(right.id)
    );
  });
  const video = sortedClips
    .filter((clip) => tracks.get(clip.trackId)?.kind === "VIDEO")
    .map((clip) => ({
      clipId: clip.id,
      trackOrder: tracks.get(clip.trackId)!.order,
      inputIndex: inputIndex.get(clip.assetId)!,
      sourceStartMs: clip.sourceStartMs,
      sourceEndMs: clip.sourceEndMs,
      timelineStartMs: clip.timelineStartMs,
      playbackRate: clip.playbackRate,
      transform: clip.transform,
    }));
  const audio = sortedClips
    .filter((clip) => tracks.get(clip.trackId)?.kind === "AUDIO")
    .map((clip) => ({
      clipId: clip.id,
      trackOrder: tracks.get(clip.trackId)!.order,
      inputIndex: inputIndex.get(clip.assetId)!,
      sourceStartMs: clip.sourceStartMs,
      sourceEndMs: clip.sourceEndMs,
      timelineStartMs: clip.timelineStartMs,
      playbackRate: clip.playbackRate,
      settings: clip.audio,
    }));
  const overlays = [...document.overlays].sort(
    (left, right) =>
      left.zIndex - right.zIndex ||
      left.startMs - right.startMs ||
      left.id.localeCompare(right.id),
  );
  return {
    manifestVersion: 1,
    editSchemaVersion: 2,
    durationMs: document.timelineDurationMs,
    canvas: document.canvas,
    inputs: assetIds.map((assetId, index) => ({ index, assetId })),
    video,
    audio,
    overlays,
    captions: document.captionStyle,
    captionCues,
    output: {
      container: "mp4",
      videoCodec: "libx264",
      audioCodec: "aac",
      pixelFormat: "yuv420p",
      fastStart: true,
    },
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Cannot serialize non-finite render data");
  return value;
}

export function stableSerializeRenderManifest(
  manifest: FfmpegRenderManifest,
): string {
  return JSON.stringify(canonicalize(manifest));
}
