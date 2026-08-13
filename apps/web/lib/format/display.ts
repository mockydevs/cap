/**
 * Display formatting shared by every surface that shows a recording. Kept in
 * one place so a duration reads the same in the library wall, the hero, and
 * the viewer.
 */

/** `mm:ss`, or `h:mm:ss` once a recording runs past an hour. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function formatViews(value: number): string {
  return `${formatCount(value)} ${value === 1 ? "view" : "views"}`;
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(iso),
  );
}

/** Up to two letters, for the square account tile in the workspace bar. */
export function initialsOf(displayName: string): string {
  return (
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?"
  );
}
