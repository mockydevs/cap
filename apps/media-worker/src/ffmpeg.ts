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
  const durationSeconds = Number(result.format?.duration);
  const width = stream?.width;
  const height = stream?.height;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  )
    throw new Error("source has no valid video stream");
  return { durationSeconds, width: width as number, height: height as number };
}

export async function createPlaybackAssets(
  inputPath: string,
  outputDirectory: string,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await execute("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    `${outputDirectory}/playback.mp4`,
  ]);
  await execute("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-hls_time",
    "6",
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    `${outputDirectory}/segment-%03d.ts`,
    `${outputDirectory}/master.m3u8`,
  ]);
  await execute("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    "00:00:01",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=1280:-2:force_original_aspect_ratio=decrease",
    `${outputDirectory}/poster.jpg`,
  ]);
}
