export type CaptionSegment = {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speakerLabel?: string | null;
};

function timestamp(milliseconds: number, separator: "." | ",") {
  const total = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const remainder = total % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(remainder).padStart(3, "0")}`;
}

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
      `${timestamp(segment.startMs, ".")} --> ${timestamp(segment.endMs, ".")}\n${captionText(segment)}`,
  );
  return cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "WEBVTT\n";
}

export function toSrt(segments: readonly CaptionSegment[]): string {
  const cues = validSegments(segments).map(
    (segment, index) =>
      `${index + 1}\n${timestamp(segment.startMs, ",")} --> ${timestamp(segment.endMs, ",")}\n${captionText(segment)}`,
  );
  return cues.length ? `${cues.join("\n\n")}\n` : "";
}
