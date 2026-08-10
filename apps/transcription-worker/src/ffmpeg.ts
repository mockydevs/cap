import { spawn } from "node:child_process";
export function extractNormalizedAudio(
  source: string,
  output: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        source,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-af",
        "loudnorm=I=-16:LRA=11:TP=-1.5",
        "-c:a",
        "pcm_s16le",
        "-y",
        output,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      Number(process.env.FFMPEG_TIMEOUT_MS ?? "1800000"),
    );
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            new Error(`FFmpeg audio extraction failed (${code}): ${stderr}`),
          );
    });
  });
}
