import { z } from "zod";

export const CURRENT_EDIT_SCHEMA_VERSION = 2 as const;

const brandedId = <Name extends string>(name: Name) =>
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
    .brand<Name>();

export const recordingIdSchema = brandedId("RecordingId");
export const projectIdSchema = brandedId("ProjectId");
export const assetIdSchema = brandedId("AssetId");
export const trackIdSchema = brandedId("TrackId");
export const clipIdSchema = brandedId("ClipId");
export const overlayIdSchema = brandedId("OverlayId");
export type AssetId = z.infer<typeof assetIdSchema>;
export type ProjectId = z.infer<typeof projectIdSchema>;
export type TrackId = z.infer<typeof trackIdSchema>;
export type ClipId = z.infer<typeof clipIdSchema>;
export type OverlayId = z.infer<typeof overlayIdSchema>;

const finite = z.number().finite();
const milliseconds = z
  .number()
  .int()
  .min(0)
  .max(7 * 24 * 60 * 60 * 1000);
const color = z.string().regex(/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/);
const point = z.object({ timeMs: milliseconds, value: finite }).strict();

export const trackSchema = z
  .object({
    id: trackIdSchema,
    kind: z.enum(["VIDEO", "AUDIO", "OVERLAY", "CAPTION"]),
    name: z.string().min(1).max(100),
    order: z.number().int().min(0).max(1_000),
    muted: z.boolean(),
    locked: z.boolean(),
  })
  .strict();

export const transformSchema = z
  .object({
    x: finite,
    y: finite,
    width: finite.positive(),
    height: finite.positive(),
    rotationDegrees: finite.min(-360).max(360),
    opacity: finite.min(0).max(1),
    crop: z
      .object({
        top: finite.min(0).max(1),
        right: finite.min(0).max(1),
        bottom: finite.min(0).max(1),
        left: finite.min(0).max(1),
      })
      .strict(),
    zoomKeyframes: z
      .array(
        z
          .object({
            timeMs: milliseconds,
            scale: finite.min(0.1).max(20),
            x: finite,
            y: finite,
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export const clipSchema = z
  .object({
    id: clipIdSchema,
    trackId: trackIdSchema,
    assetId: assetIdSchema,
    sourceStartMs: milliseconds,
    sourceEndMs: milliseconds,
    timelineStartMs: milliseconds,
    playbackRate: finite.min(0.1).max(8),
    transform: transformSchema,
    audio: z
      .object({
        muted: z.boolean(),
        gainDb: finite.min(-96).max(24),
        fadeInMs: milliseconds,
        fadeOutMs: milliseconds,
        noiseReduction: z.boolean(),
        gainAutomation: z.array(point).max(2_000),
      })
      .strict(),
  })
  .strict();

const overlayBase = {
  id: overlayIdSchema,
  trackId: trackIdSchema,
  startMs: milliseconds,
  endMs: milliseconds,
  x: finite,
  y: finite,
  width: finite.positive(),
  height: finite.positive(),
  opacity: finite.min(0).max(1),
  zIndex: z.number().int().min(-10_000).max(10_000),
};

export const overlaySchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...overlayBase,
      kind: z.literal("TEXT"),
      text: z.string().min(1).max(10_000),
      color,
      fontSize: finite.min(6).max(500),
      backgroundColor: color.optional(),
    })
    .strict(),
  z
    .object({
      ...overlayBase,
      kind: z.literal("IMAGE"),
      assetId: assetIdSchema,
      fit: z.enum(["CONTAIN", "COVER", "FILL"]),
    })
    .strict(),
  z
    .object({
      ...overlayBase,
      kind: z.literal("SHAPE"),
      shape: z.enum(["RECTANGLE", "ELLIPSE", "ARROW", "CALLOUT"]),
      fillColor: color,
      strokeColor: color,
      strokeWidth: finite.min(0).max(100),
    })
    .strict(),
  z
    .object({
      ...overlayBase,
      kind: z.literal("BLUR"),
      strength: finite.min(0.1).max(100),
    })
    .strict(),
]);

export const canvasSchema = z
  .object({
    width: z.number().int().min(16).max(7_680),
    height: z.number().int().min(16).max(4_320),
    frameRate: z.number().int().min(1).max(120),
    background: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("COLOR"), color }).strict(),
      z
        .object({
          kind: z.literal("GRADIENT"),
          from: color,
          to: color,
          angleDegrees: finite.min(0).max(360),
        })
        .strict(),
      z
        .object({
          kind: z.literal("IMAGE"),
          assetId: assetIdSchema,
          fit: z.enum(["CONTAIN", "COVER", "FILL"]),
        })
        .strict(),
    ]),
    padding: finite.min(0).max(1_000),
    borderRadius: finite.min(0).max(1_000),
    shadow: z
      .object({
        enabled: z.boolean(),
        blur: finite.min(0).max(500),
        x: finite,
        y: finite,
        color,
      })
      .strict(),
  })
  .strict();

export const captionStyleSchema = z
  .object({
    enabled: z.boolean(),
    fontFamily: z.string().min(1).max(200),
    fontSize: finite.min(6).max(300),
    textColor: color,
    backgroundColor: color,
    position: z.enum(["TOP", "CENTER", "BOTTOM"]),
    maxLines: z.number().int().min(1).max(5),
    burnIn: z.boolean(),
  })
  .strict();

const documentV2Base = z
  .object({
    schemaVersion: z.literal(CURRENT_EDIT_SCHEMA_VERSION),
    recordingId: recordingIdSchema,
    sourceAssetIds: z.array(assetIdSchema).min(1).max(1_000),
    timelineDurationMs: milliseconds,
    tracks: z.array(trackSchema).min(1).max(100),
    clips: z.array(clipSchema).max(10_000),
    overlays: z.array(overlaySchema).max(10_000),
    captionStyle: captionStyleSchema,
    canvas: canvasSchema,
  })
  .strict();

export const editorDocumentV2Schema = documentV2Base.superRefine(
  (document, context) => {
    const unique = (values: readonly string[], path: (string | number)[]) => {
      if (new Set(values).size !== values.length)
        context.addIssue({
          code: "custom",
          message: "IDs must be unique",
          path,
        });
    };
    unique(document.sourceAssetIds, ["sourceAssetIds"]);
    unique(
      document.tracks.map((track) => track.id),
      ["tracks"],
    );
    unique(
      document.clips.map((clip) => clip.id),
      ["clips"],
    );
    unique(
      document.overlays.map((overlay) => overlay.id),
      ["overlays"],
    );
    unique(
      document.tracks.map((track) => String(track.order)),
      ["tracks"],
    );
    const tracks = new Map(document.tracks.map((track) => [track.id, track]));
    const assets = new Set(document.sourceAssetIds);
    for (const [index, clip] of document.clips.entries()) {
      const track = tracks.get(clip.trackId);
      if (!track || (track.kind !== "VIDEO" && track.kind !== "AUDIO"))
        context.addIssue({
          code: "custom",
          message: "Clip requires a video or audio track",
          path: ["clips", index, "trackId"],
        });
      if (!assets.has(clip.assetId))
        context.addIssue({
          code: "custom",
          message: "Clip asset is not declared",
          path: ["clips", index, "assetId"],
        });
      if (clip.sourceEndMs <= clip.sourceStartMs)
        context.addIssue({
          code: "custom",
          message: "Clip source range must be increasing",
          path: ["clips", index],
        });
      const duration =
        (clip.sourceEndMs - clip.sourceStartMs) / clip.playbackRate;
      if (clip.timelineStartMs + duration > document.timelineDurationMs)
        context.addIssue({
          code: "custom",
          message: "Clip exceeds timeline duration",
          path: ["clips", index],
        });
      if (clip.audio.fadeInMs + clip.audio.fadeOutMs > duration)
        context.addIssue({
          code: "custom",
          message: "Audio fades exceed clip duration",
          path: ["clips", index, "audio"],
        });
    }
    for (const [index, overlay] of document.overlays.entries()) {
      if (tracks.get(overlay.trackId)?.kind !== "OVERLAY")
        context.addIssue({
          code: "custom",
          message: "Overlay requires an overlay track",
          path: ["overlays", index, "trackId"],
        });
      if (
        overlay.endMs <= overlay.startMs ||
        overlay.endMs > document.timelineDurationMs
      )
        context.addIssue({
          code: "custom",
          message: "Overlay timing is invalid",
          path: ["overlays", index],
        });
      if (overlay.kind === "IMAGE" && !assets.has(overlay.assetId))
        context.addIssue({
          code: "custom",
          message: "Overlay asset is not declared",
          path: ["overlays", index, "assetId"],
        });
    }
    const referencedBackground =
      document.canvas.background.kind === "IMAGE"
        ? document.canvas.background.assetId
        : undefined;
    if (referencedBackground && !assets.has(referencedBackground))
      context.addIssue({
        code: "custom",
        message: "Canvas asset is not declared",
        path: ["canvas", "background", "assetId"],
      });
    for (const track of document.tracks.filter(
      (item) => item.kind === "VIDEO" || item.kind === "AUDIO",
    )) {
      const clips = document.clips
        .filter((clip) => clip.trackId === track.id)
        .sort(
          (a, b) =>
            a.timelineStartMs - b.timelineStartMs || a.id.localeCompare(b.id),
        );
      for (let index = 1; index < clips.length; index += 1) {
        const previous = clips[index - 1]!;
        const current = clips[index]!;
        const previousEnd =
          previous.timelineStartMs +
          (previous.sourceEndMs - previous.sourceStartMs) /
            previous.playbackRate;
        if (current.timelineStartMs < previousEnd)
          context.addIssue({
            code: "custom",
            message: "Clips on one track may not overlap",
            path: ["clips"],
          });
      }
    }
  },
);

export type EditorDocumentV2 = z.infer<typeof editorDocumentV2Schema>;
export type Track = z.infer<typeof trackSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type Overlay = z.infer<typeof overlaySchema>;
export type Canvas = z.infer<typeof canvasSchema>;

const documentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    recordingId: recordingIdSchema,
    sourceAssetIds: z.array(assetIdSchema).min(1),
    timelineDurationMs: milliseconds,
    tracks: z.array(trackSchema).min(1),
    clips: z.array(clipSchema),
    overlays: z.array(overlaySchema),
    backgroundColor: color,
  })
  .strict();

export function validateEditDocument(value: unknown): EditorDocumentV2 {
  return editorDocumentV2Schema.parse(value);
}

/** Migrations are pure, ordered and idempotent: current documents only validate. */
export function parseAndMigrateEditDocument(value: unknown): EditorDocumentV2 {
  const version = z
    .object({ schemaVersion: z.number().int() })
    .passthrough()
    .parse(value).schemaVersion;
  if (version === CURRENT_EDIT_SCHEMA_VERSION)
    return validateEditDocument(value);
  if (version !== 1)
    throw new Error(`Unsupported edit schema version: ${version}`);
  const old = documentV1Schema.parse(value);
  return validateEditDocument({
    schemaVersion: 2,
    recordingId: old.recordingId,
    sourceAssetIds: old.sourceAssetIds,
    timelineDurationMs: old.timelineDurationMs,
    tracks: old.tracks,
    clips: old.clips,
    overlays: old.overlays,
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
      width: 1920,
      height: 1080,
      frameRate: 30,
      background: { kind: "COLOR", color: old.backgroundColor },
      padding: 0,
      borderRadius: 0,
      shadow: { enabled: false, blur: 0, x: 0, y: 0, color: "#00000000" },
    },
  });
}
