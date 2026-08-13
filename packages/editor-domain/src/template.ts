import { z } from "zod";
import {
  assetIdSchema,
  clipSchema,
  editorDocumentV2Schema,
  overlaySchema,
  type Clip,
  type EditorDocumentV2,
  type Overlay,
} from "./model";

/**
 * A reusable, workspace-owned fragment of timeline content — an intro,
 * outro, or general reusable clip/overlay set — captured relative to its
 * own 0-based timeline so it can be spliced into any project's timeline.
 * Clips/overlays must reference the fixed track IDs every project is
 * initialized with (track_video_primary, track_audio_primary,
 * track_overlays, track_captions — see initializeEditorDocument).
 */
export const editorTemplateFragmentSchema = z
  .object({
    sourceAssetIds: z.array(assetIdSchema).min(1).max(1_000),
    clips: z.array(clipSchema).max(1_000),
    overlays: z.array(overlaySchema).max(1_000),
    durationMs: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60 * 1000),
  })
  .strict()
  .superRefine((fragment, context) => {
    const assets = new Set(fragment.sourceAssetIds);
    for (const [index, clip] of fragment.clips.entries()) {
      if (!assets.has(clip.assetId))
        context.addIssue({
          code: "custom",
          message: "Clip asset is not declared in the template",
          path: ["clips", index, "assetId"],
        });
      const duration =
        (clip.sourceEndMs - clip.sourceStartMs) / clip.playbackRate;
      if (clip.timelineStartMs + duration > fragment.durationMs)
        context.addIssue({
          code: "custom",
          message: "Clip exceeds the template's declared duration",
          path: ["clips", index],
        });
    }
    for (const [index, overlay] of fragment.overlays.entries()) {
      if (overlay.endMs > fragment.durationMs)
        context.addIssue({
          code: "custom",
          message: "Overlay exceeds the template's declared duration",
          path: ["overlays", index],
        });
      if (overlay.kind === "IMAGE" && !assets.has(overlay.assetId))
        context.addIssue({
          code: "custom",
          message: "Overlay asset is not declared in the template",
          path: ["overlays", index, "assetId"],
        });
    }
  });
export type EditorTemplateFragment = z.infer<
  typeof editorTemplateFragmentSchema
>;

export interface TemplateIdFactory {
  clipId(): Clip["id"];
  overlayId(): Overlay["id"];
}

/** Captures an existing project's current timeline as a reusable fragment. */
export function captureTemplateFragment(
  document: EditorDocumentV2,
): EditorTemplateFragment {
  return editorTemplateFragmentSchema.parse({
    sourceAssetIds: document.sourceAssetIds,
    clips: document.clips,
    overlays: document.overlays,
    durationMs: document.timelineDurationMs,
  });
}

/**
 * Splices a template fragment into a project's timeline as an intro
 * (before everything, shifting the rest later) or an outro (after
 * everything). Fresh clip/overlay IDs are minted so the same template can
 * be applied more than once — to the same project or different ones —
 * without ID collisions.
 */
export function applyTemplate(
  document: EditorDocumentV2,
  fragment: EditorTemplateFragment,
  position: "INTRO" | "OUTRO",
  ids: TemplateIdFactory,
): EditorDocumentV2 {
  const sourceAssetIds = [...document.sourceAssetIds];
  for (const assetId of fragment.sourceAssetIds)
    if (!sourceAssetIds.includes(assetId)) sourceAssetIds.push(assetId);

  const templateClips: Clip[] = fragment.clips.map((clip) => ({
    ...clip,
    id: ids.clipId(),
  }));
  const templateOverlays: Overlay[] = fragment.overlays.map((overlay) => ({
    ...overlay,
    id: ids.overlayId(),
  }));

  const shiftClip = (clip: Clip, shiftMs: number): Clip => ({
    ...clip,
    timelineStartMs: clip.timelineStartMs + shiftMs,
  });
  const shiftOverlay = (overlay: Overlay, shiftMs: number): Overlay => ({
    ...overlay,
    startMs: overlay.startMs + shiftMs,
    endMs: overlay.endMs + shiftMs,
  });

  const clips =
    position === "INTRO"
      ? [
          ...templateClips,
          ...document.clips.map((clip) => shiftClip(clip, fragment.durationMs)),
        ]
      : [
          ...document.clips,
          ...templateClips.map((clip) =>
            shiftClip(clip, document.timelineDurationMs),
          ),
        ];
  const overlays =
    position === "INTRO"
      ? [
          ...templateOverlays,
          ...document.overlays.map((overlay) =>
            shiftOverlay(overlay, fragment.durationMs),
          ),
        ]
      : [
          ...document.overlays,
          ...templateOverlays.map((overlay) =>
            shiftOverlay(overlay, document.timelineDurationMs),
          ),
        ];

  return editorDocumentV2Schema.parse({
    ...document,
    sourceAssetIds,
    clips,
    overlays,
    timelineDurationMs: document.timelineDurationMs + fragment.durationMs,
  });
}
