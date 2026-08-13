import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

export class MediaCommandError extends Error {
  constructor(
    readonly command: string,
    readonly output: string,
  ) {
    super(`${command} failed: ${output}`);
  }
}

async function execute(
  command: string,
  arguments_: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8_000);
    });
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      Number(process.env.FFMPEG_TIMEOUT_MS ?? "1800000"),
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(output)
        : reject(new MediaCommandError(command, output));
    });
  });
}

export async function inspectMedia(
  inputPath: string,
): Promise<{ durationSeconds: number; width: number; height: number }> {
  const output = await execute("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height:format=duration",
    "-of",
    "json",
    inputPath,
  ]);
  const parsed: unknown = JSON.parse(output);
  if (!parsed || typeof parsed !== "object")
    throw new Error("ffprobe returned invalid JSON");
  const result = parsed as {
    format?: { duration?: string };
    streams?: Array<{ width?: number; height?: number }>;
  };
  const stream = result.streams?.[0];
  let durationSeconds = Number(result.format?.duration);
  const width = stream?.width;
  const height = stream?.height;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    const packetTimeline = await execute("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time,duration_time",
      "-of",
      "csv=p=0",
      inputPath,
    ]);
    durationSeconds = durationFromPacketTimeline(packetTimeline);
  }
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  )
    throw new Error("source has no valid video stream");
  return { durationSeconds, width: width as number, height: height as number };
}

/**
 * MediaRecorder's timesliced WebM output often has no container duration.
 * ffprobe still exposes timestamps for every video packet, so the final packet
 * end is a reliable duration fallback without decoding the whole recording.
 */
export function durationFromPacketTimeline(output: string): number {
  let duration = 0;
  for (const line of output.split(/\r?\n/)) {
    const [timestampValue, durationValue] = line.trim().split(",");
    const timestamp = Number(timestampValue);
    const packetDuration = Number(durationValue);
    if (!Number.isFinite(timestamp) || timestamp < 0) continue;
    duration = Math.max(
      duration,
      timestamp +
        (Number.isFinite(packetDuration) && packetDuration > 0
          ? packetDuration
          : 0),
    );
  }
  return duration;
}

/** Segment length for the HLS rendition, in seconds. */
const HLS_SEGMENT_SECONDS = 6;

const BASE_ARGUMENTS = ["-hide_banner", "-loglevel", "error", "-y"] as const;

/**
 * The one and only re-encode: source (usually VP9/Opus from MediaRecorder) to
 * H.264/AAC. Keyframes are forced on the HLS segment boundary so the playlist
 * can be cut straight out of this file without touching the video again.
 *
 * `veryfast` rather than a slower preset because this runs per upload on shared
 * worker hardware; for screen content the size difference is small next to the
 * several-fold difference in CPU time.
 */
export function playbackEncodeArguments(
  inputPath: string,
  outputPath: string,
): string[] {
  return [
    ...BASE_ARGUMENTS,
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-force_key_frames",
    `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    outputPath,
  ];
}

/**
 * Packages the encoded MP4 as HLS by copying the streams. No `-c:v` here on
 * purpose: re-encoding for a second rendition of the same quality would double
 * the cost of every upload for no gain.
 */
export function hlsPackageArguments(
  mp4Path: string,
  outputDirectory: string,
): string[] {
  return [
    ...BASE_ARGUMENTS,
    "-i",
    mp4Path,
    "-c",
    "copy",
    "-f",
    "hls",
    "-hls_time",
    String(HLS_SEGMENT_SECONDS),
    "-hls_playlist_type",
    "vod",
    "-hls_segment_type",
    "mpegts",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_filename",
    `${outputDirectory}/segment-%03d.ts`,
    `${outputDirectory}/master.m3u8`,
  ];
}

/**
 * A frame one second in usually beats frame zero, which is often a blank
 * window still mid-paint — but clips shorter than that need an earlier seek or
 * ffmpeg writes no frame at all.
 */
export function posterArguments(
  mp4Path: string,
  outputPath: string,
  durationSeconds: number,
): string[] {
  const seekSeconds = durationSeconds > 1 ? 1 : durationSeconds / 2;
  return [
    ...BASE_ARGUMENTS,
    "-ss",
    seekSeconds.toFixed(3),
    "-i",
    mp4Path,
    "-frames:v",
    "1",
    "-vf",
    "scale=1280:-2:force_original_aspect_ratio=decrease",
    outputPath,
  ];
}

export async function createPlaybackAssets(
  inputPath: string,
  outputDirectory: string,
  durationSeconds: number,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const mp4Path = `${outputDirectory}/playback.mp4`;
  await execute("ffmpeg", playbackEncodeArguments(inputPath, mp4Path));
  await execute("ffmpeg", hlsPackageArguments(mp4Path, outputDirectory));
  await execute(
    "ffmpeg",
    posterArguments(mp4Path, `${outputDirectory}/poster.jpg`, durationSeconds),
  );
}
