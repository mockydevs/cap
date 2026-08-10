import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertExecutableRenderManifest,
  UnsupportedRenderFeatureError,
  type FfmpegRenderManifest,
} from "@cap/editor-domain";
import { buildForceStyle, generateSrt } from "./captions";
import {
  audioClipFilterChain,
  ffmpegColor,
  generatedOverlayFilterChain,
  imageOverlayFilterChain,
  videoClipFilterChain,
} from "./filters";

export { UnsupportedRenderFeatureError };
/** Kept for the existing test suite's import name; delegates to the shared domain gate. */
export const assertExecutableManifest = assertExecutableRenderManifest;

const FONT_FILE = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

class Labels {
  #counters = new Map<string, number>();
  next(prefix: string): string {
    const count = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, count);
    return `${prefix}${count}`;
  }
}

/**
 * Compiles a validated manifest into a full FFmpeg filter_complex graph: a
 * full-duration color canvas, each video clip time-windowed onto it via
 * `overlay=enable='between(t,...)'` (clips are gapless per
 * assertExecutableRenderManifest, so exactly one is active at any instant),
 * then overlays (text/image/shape/blur) composited the same way, then an
 * optional subtitles burn-in pass, plus a parallel audio mix graph.
 *
 * Writes overlay text and the caption SRT (when burning in captions) as
 * files under `workDir` — passing them as FFmpeg option values directly
 * would require reproducing FFmpeg's filtergraph string-escaping rules for
 * arbitrary user text, which a temp file sidesteps entirely.
 */
export async function renderArguments(
  manifest: FfmpegRenderManifest,
  inputs: string[],
  output: string,
  workDir: string,
): Promise<string[]> {
  assertExecutableManifest(manifest);
  if (!manifest.video.length)
    throw new Error("Render manifest has no video clips");
  const labels = new Labels();
  const durationSec = manifest.durationMs / 1000;
  const filters: string[] = [];

  const background = manifest.canvas.background as {
    kind: "COLOR";
    color: string;
  };
  let composite = labels.next("base");
  filters.push(
    `color=c=${ffmpegColor(background.color)}:s=${manifest.canvas.width}x${manifest.canvas.height}:d=${durationSec.toFixed(3)}:r=${manifest.canvas.frameRate}[${composite}]`,
  );

  for (const clip of manifest.video) {
    const offsetSec = clip.timelineStartMs / 1000;
    const durationSeconds =
      (clip.sourceEndMs - clip.sourceStartMs) / 1000 / clip.playbackRate;
    const chain = videoClipFilterChain({ transform: clip.transform });
    const clipLabel = labels.next("vclip");
    filters.push(
      `[${clip.inputIndex}:v]trim=start=${clip.sourceStartMs / 1000}:end=${clip.sourceEndMs / 1000},setpts=(PTS-STARTPTS)/${clip.playbackRate},${chain},setpts=PTS+${offsetSec.toFixed(6)}/TB[${clipLabel}]`,
    );
    const next = labels.next("base");
    filters.push(
      `[${composite}][${clipLabel}]overlay=x=${Math.round(clip.transform.x)}:y=${Math.round(clip.transform.y)}:eof_action=pass:enable='between(t,${offsetSec.toFixed(6)},${(offsetSec + durationSeconds).toFixed(6)})'[${next}]`,
    );
    composite = next;
  }

  const inputIndexByAssetId = new Map(
    manifest.inputs.map((input) => [input.assetId, input.index]),
  );
  let textFileCount = 0;
  for (const overlay of manifest.overlays) {
    const overlayLabel = labels.next("ov");
    if (overlay.kind === "IMAGE") {
      const inputIndex = inputIndexByAssetId.get(overlay.assetId);
      if (inputIndex === undefined)
        throw new Error("Overlay asset is not an available input");
      filters.push(
        `[${inputIndex}:v]${imageOverlayFilterChain(overlay)}[${overlayLabel}]`,
      );
    } else if (overlay.kind === "BLUR") {
      const mainLabel = labels.next("base");
      const blurSourceLabel = labels.next("blursrc");
      filters.push(`[${composite}]split=2[${mainLabel}][${blurSourceLabel}]`);
      composite = mainLabel;
      filters.push(
        `[${blurSourceLabel}]crop=${Math.round(overlay.width)}:${Math.round(overlay.height)}:${Math.round(overlay.x)}:${Math.round(overlay.y)},boxblur=${Math.round(overlay.strength)}[${overlayLabel}]`,
      );
    } else {
      let textFilePath: string | undefined;
      if (overlay.kind === "TEXT") {
        textFileCount += 1;
        textFilePath = join(workDir, `overlay-text-${textFileCount}.txt`);
        await writeFile(textFilePath, overlay.text, "utf8");
      }
      filters.push(
        `${generatedOverlayFilterChain({ overlay, textFilePath, fontFilePath: FONT_FILE })}[${overlayLabel}]`,
      );
    }
    const next = labels.next("base");
    filters.push(
      `[${composite}][${overlayLabel}]overlay=x=${Math.round(overlay.x)}:y=${Math.round(overlay.y)}:eof_action=pass:enable='between(t,${(overlay.startMs / 1000).toFixed(6)},${(overlay.endMs / 1000).toFixed(6)})'[${next}]`,
    );
    composite = next;
  }

  if (manifest.captions.burnIn) {
    const srtPath = join(workDir, "captions.srt");
    await writeFile(srtPath, generateSrt(manifest.captionCues), "utf8");
    const next = labels.next("base");
    filters.push(
      `[${composite}]subtitles=filename=${srtPath}:force_style='${buildForceStyle(manifest.captions)}'[${next}]`,
    );
    composite = next;
  }

  const audioLabels: string[] = [];
  for (const clip of manifest.audio) {
    const durationSeconds =
      (clip.sourceEndMs - clip.sourceStartMs) / 1000 / clip.playbackRate;
    const chain = audioClipFilterChain(
      clip.settings,
      durationSeconds,
      clip.playbackRate,
    );
    if (!chain) continue;
    const label = labels.next("aclip");
    filters.push(
      `[${clip.inputIndex}:a]atrim=start=${clip.sourceStartMs / 1000}:end=${clip.sourceEndMs / 1000},asetpts=PTS-STARTPTS,${chain},adelay=delays=${Math.round(clip.timelineStartMs)}:all=1[${label}]`,
    );
    audioLabels.push(label);
  }
  let audioOutputLabel: string | undefined;
  if (audioLabels.length) {
    audioOutputLabel = labels.next("mix");
    filters.push(
      `${audioLabels.map((label) => `[${label}]`).join("")}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0[${audioOutputLabel}]`,
    );
  }

  const usedByClips = new Set([
    ...manifest.video.map((clip) => clip.inputIndex),
    ...manifest.audio.map((clip) => clip.inputIndex),
  ]);
  const usedByImageOverlays = new Set(
    manifest.overlays
      .filter((overlay) => overlay.kind === "IMAGE")
      .map((overlay) => inputIndexByAssetId.get(overlay.assetId)),
  );

  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  for (const [index, input] of inputs.entries()) {
    if (usedByImageOverlays.has(index) && !usedByClips.has(index))
      args.push("-loop", "1");
    args.push("-i", input);
  }
  args.push("-filter_complex", filters.join(";"), "-map", `[${composite}]`);
  if (audioOutputLabel) args.push("-map", `[${audioOutputLabel}]`, "-c:a", "aac");
  else args.push("-an");
  args.push(
    "-t",
    durationSec.toFixed(3),
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
  workDir: string,
) {
  return new Promise<void>((resolve, reject) => {
    void renderArguments(manifest, inputs, output, workDir).then(
      (args) => {
        const child = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", args, {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on(
          "data",
          (chunk) => (stderr = `${stderr}${String(chunk)}`.slice(-4000)),
        );
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          code === 0
            ? resolve()
            : reject(new Error(`FFmpeg render failed (${code}): ${stderr}`));
        });
      },
      reject,
    );
  });
}
