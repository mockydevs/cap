import { formatCaptionTimestamp } from "@cap/transcription";

export type CaptionSegment = {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speakerLabel?: string | null;
};

function captionText(segment: CaptionSegment) {
  const speaker = segment.speakerLabel?.trim();
  const content = segment.text
    .replace(/\r\n?/g, "\n")
    .replace(/-->/g, "→")
    .trim();
  return speaker ? `${speaker}: ${content}` : content;
}

function validSegments(segments: readonly CaptionSegment[]) {
  return segments.filter(
    (segment) =>
      Number.isInteger(segment.startMs) &&
      Number.isInteger(segment.endMs) &&
      segment.startMs >= 0 &&
      segment.endMs > segment.startMs &&
      captionText(segment).trim().length > 0,
  );
}

export function toWebVtt(segments: readonly CaptionSegment[]): string {
  const cues = validSegments(segments).map(
    (segment) =>
      `${formatCaptionTimestamp(segment.startMs, ".")} --> ${formatCaptionTimestamp(segment.endMs, ".")}\n${captionText(segment)}`,
  );
  return cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "WEBVTT\n";
}

export function toSrt(segments: readonly CaptionSegment[]): string {
  const cues = validSegments(segments).map(
    (segment, index) =>
      `${index + 1}\n${formatCaptionTimestamp(segment.startMs, ",")} --> ${formatCaptionTimestamp(segment.endMs, ",")}\n${captionText(segment)}`,
  );
  return cues.length ? `${cues.join("\n\n")}\n` : "";
}
