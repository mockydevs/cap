export type CaptureState =
  | "idle"
  | "requesting"
  | "recording"
  | "stopping"
  | "uploading"
  | "ready"
  | "error";

/**
 * H.264/AAC in MP4 first, because that is what plays back everywhere without
 * being re-encoded: the recording is servable the moment it finishes uploading,
 * and transcoding becomes an enhancement rather than something playback waits
 * on. VP9 gives smaller files, which mattered when every recording was
 * transcoded anyway; it no longer outweighs starting playback sooner.
 *
 * Browsers that will not record MP4 fall through to WebM and the transcode
 * path, exactly as before.
 */
export function selectRecorderMimeType(
  supported: (mimeType: string) => boolean,
): string | undefined {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find(supported);
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
