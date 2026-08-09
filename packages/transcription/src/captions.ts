import { approvedSegmentText, type CanonicalSegment } from "./merge";
import { TranscriptionContractError, validateTimedText } from "./contracts";

function timestamp(milliseconds: number, decimal: "." | ","): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new TranscriptionContractError("Invalid caption timestamp");
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${decimal}${String(millis).padStart(3, "0")}`;
}

function cues(segments: readonly CanonicalSegment[]) {
  return [...segments]
    .filter(
      (segment) => !segment.isOrphaned || approvedSegmentText(segment).trim(),
    )
    .sort(
      (left, right) =>
        left.startMs - right.startMs || left.id.localeCompare(right.id),
    )
    .map((segment) => {
      const text = approvedSegmentText(segment).trim().replace(/\r\n?/g, "\n");
      validateTimedText(segment.startMs, segment.endMs, text);
      return { ...segment, text };
    });
}

export function renderWebVtt(segments: readonly CanonicalSegment[]): string {
  const body = cues(segments).map((cue) => {
    const text = cue.text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return `${cue.id}\n${timestamp(cue.startMs, ".")} --> ${timestamp(cue.endMs, ".")}\n${text}`;
  });
  return `WEBVTT\n\n${body.join("\n\n")}${body.length ? "\n" : ""}`;
}

export function renderSrt(segments: readonly CanonicalSegment[]): string {
  const body = cues(segments).map(
    (cue, index) =>
      `${index + 1}\n${timestamp(cue.startMs, ",")} --> ${timestamp(cue.endMs, ",")}\n${cue.text}`,
  );
  return `${body.join("\n\n")}${body.length ? "\n" : ""}`;
}
