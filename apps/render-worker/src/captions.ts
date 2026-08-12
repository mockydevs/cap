import type { FfmpegRenderManifest } from "@cap/editor-domain";
import { formatCaptionTimestamp } from "@cap/transcription";

type CaptionCue = FfmpegRenderManifest["captionCues"][number];
type CaptionStyle = FfmpegRenderManifest["captions"];

/** Cues must already be ordered and non-overlapping (the approved transcript guarantees this). */
export function generateSrt(cues: readonly CaptionCue[]): string {
  const blocks = cues
    .filter((cue) => cue.endMs > cue.startMs && cue.text.trim().length > 0)
    .map(
      (cue, index) =>
        `${index + 1}\n${formatCaptionTimestamp(cue.startMs, ",")} --> ${formatCaptionTimestamp(cue.endMs, ",")}\n${cue.text.trim().replaceAll("\n", " ")}`,
    );
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

/** Web "#RRGGBB[AA]" (AA: 00 transparent-255 opaque) -> ASS "&HAABBGGRR&" (AA inverted: 00 opaque). */
export function toAssColor(hex: string): string {
  const rr = hex.slice(1, 3);
  const gg = hex.slice(3, 5);
  const bb = hex.slice(5, 7);
  const webAlpha = hex.length === 9 ? Number.parseInt(hex.slice(7, 9), 16) : 255;
  const assAlpha = (255 - webAlpha)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `&H${assAlpha}${bb.toUpperCase()}${gg.toUpperCase()}${rr.toUpperCase()}&`;
}

const ASS_ALIGNMENT: Record<CaptionStyle["position"], number> = {
  BOTTOM: 2,
  CENTER: 5,
  TOP: 8,
};

/** libass force_style override string for the `subtitles` filter. */
export function buildForceStyle(style: CaptionStyle): string {
  return [
    `FontName=${style.fontFamily}`,
    `FontSize=${Math.round(style.fontSize)}`,
    `PrimaryColour=${toAssColor(style.textColor)}`,
    `BackColour=${toAssColor(style.backgroundColor)}`,
    "BorderStyle=3",
    `Alignment=${ASS_ALIGNMENT[style.position]}`,
  ].join(",");
}
