import { spawn } from "node:child_process";
import type { FfmpegRenderManifest } from "@cap/editor-domain";
export class UnsupportedRenderFeatureError extends Error {
  constructor(feature: string) {
    super(`Render feature is not supported: ${feature}`);
    this.name = "UnsupportedRenderFeatureError";
  }
}
export function assertExecutableManifest(m: FfmpegRenderManifest) {
  if (
    m.canvas.background.kind !== "COLOR" ||
    m.canvas.background.color.toLowerCase() !== "#000000"
  )
    throw new UnsupportedRenderFeatureError("canvas background");
  if (m.audio.length)
    throw new UnsupportedRenderFeatureError("audio automation/fades/mute/gain");
  if (m.overlays.length)
    throw new UnsupportedRenderFeatureError(`overlay:${m.overlays[0]!.kind}`);
  if (m.captions.enabled || m.captions.burnIn)
    throw new UnsupportedRenderFeatureError("caption burn-in");
  let cursor = 0;
  for (const c of m.video) {
    if (c.timelineStartMs !== cursor)
      throw new UnsupportedRenderFeatureError("timeline gaps/overlaps");
    cursor += Math.round((c.sourceEndMs - c.sourceStartMs) / c.playbackRate);
    const t = c.transform;
    if (t.zoomKeyframes.length) throw new UnsupportedRenderFeatureError("zoom");
    if (
      t.rotationDegrees !== 0 ||
      t.opacity !== 1 ||
      t.x !== 0 ||
      t.y !== 0 ||
      t.width !== m.canvas.width ||
      t.height !== m.canvas.height ||
      Object.values(t.crop).some((v) => v !== 0)
    )
      throw new UnsupportedRenderFeatureError("transform");
  }
}
export function renderArguments(
  manifest: FfmpegRenderManifest,
  inputs: string[],
  output: string,
) {
  assertExecutableManifest(manifest);
  if (!manifest.video.length)
    throw new Error("Render manifest has no video clips");
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  for (const input of inputs) args.push("-i", input);
  const filters = manifest.video.map(
    (clip, i) =>
      `[${clip.inputIndex}:v]trim=start=${clip.sourceStartMs / 1000}:end=${clip.sourceEndMs / 1000},setpts=(PTS-STARTPTS)/${clip.playbackRate},scale=${manifest.canvas.width}:${manifest.canvas.height}:force_original_aspect_ratio=decrease,pad=${manifest.canvas.width}:${manifest.canvas.height}:(ow-iw)/2:(oh-ih)/2[v${i}]`,
  );
  filters.push(
    `${manifest.video.map((_, i) => `[v${i}]`).join("")}concat=n=${manifest.video.length}:v=1:a=0[outv]`,
  );
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[outv]",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-threads",
    "1",
    "-metadata",
    "creation_time=1970-01-01T00:00:00Z",
    "-y",
    output,
  );
  return args;
}
export function executeRender(
  manifest: FfmpegRenderManifest,
  inputs: string[],
  output: string,
  timeoutMs: number,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      renderArguments(manifest, inputs, output),
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on(
      "data",
      (c) => (stderr = `${stderr}${String(c)}`.slice(-4000)),
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(`FFmpeg render failed (${code}): ${stderr}`));
    });
  });
}
