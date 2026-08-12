/**
 * Cue timestamps for the two subtitle formats Cap emits: WebVTT separates
 * milliseconds with a decimal point, SRT with a comma. Every caption writer
 * (transcript downloads, translated exports, burned-in renders) shares this so
 * a format fix lands in one place.
 */
export function formatCaptionTimestamp(
  milliseconds: number,
  decimal: "." | ",",
): string {
  const total = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${decimal}${String(millis).padStart(3, "0")}`;
}
