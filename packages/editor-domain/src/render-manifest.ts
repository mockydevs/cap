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

export function assertExecutableRenderManifest(manifest: FfmpegRenderManifest) {
  if (
    manifest.canvas.background.kind !== "COLOR" ||
    manifest.canvas.background.color.toLowerCase() !== "#000000"
  ) {
    throw new UnsupportedRenderFeatureError("canvas background");
  }
  if (manifest.audio.length)
    throw new UnsupportedRenderFeatureError("audio automation/fades/mute/gain");
  if (manifest.overlays.length)
    throw new UnsupportedRenderFeatureError(
      `overlay:${manifest.overlays[0]!.kind}`,
    );
  if (manifest.captions.enabled || manifest.captions.burnIn)
    throw new UnsupportedRenderFeatureError("caption burn-in");
  let cursor = 0;
  for (const clip of manifest.video) {
    if (clip.timelineStartMs !== cursor)
      throw new UnsupportedRenderFeatureError("timeline gaps/overlaps");
    cursor += Math.round(
      (clip.sourceEndMs - clip.sourceStartMs) / clip.playbackRate,
    );
    const transform = clip.transform;
    if (transform.zoomKeyframes.length)
      throw new UnsupportedRenderFeatureError("zoom");
    if (
      transform.rotationDegrees !== 0 ||
      transform.opacity !== 1 ||
      transform.x !== 0 ||
      transform.y !== 0 ||
      transform.width !== manifest.canvas.width ||
      transform.height !== manifest.canvas.height ||
      Object.values(transform.crop).some((value) => value !== 0)
    ) {
      throw new UnsupportedRenderFeatureError("transform");
    }
  }
}

export function compileRenderManifest(
  value: EditorDocumentV2,
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
