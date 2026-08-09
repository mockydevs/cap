import { createReadStream, createWriteStream } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Worker, type Job } from "bullmq";
import { Pool } from "pg";
import {
  createMediaProcessingQueue,
  createRedisConnection,
  createTranscriptionQueue,
  MEDIA_PROCESSING_QUEUE,
  mediaProcessingJobSchema,
  transcriptionJobOptions,
  type MediaProcessingJob,
} from "@cap/queue";
import { createPlaybackAssets, inspectMedia } from "./ffmpeg";
import { dispatchProcessingOutbox } from "./outbox";

const PROCESSING_VERSION = 1;
type AssetKind = "MP4" | "HLS_MANIFEST" | "HLS_SEGMENT" | "POSTER";
type Asset = {
  kind: AssetKind;
  objectKey: string;
  contentType: string;
  filePath: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}
function s3(): { bucket: string; client: S3Client } {
  const endpoint = process.env.AWS_S3_ENDPOINT;
  return {
    bucket: required("AWS_S3_BUCKET_NAME"),
    client: new S3Client({
      region: process.env.AWS_REGION ?? "us-east-1",
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    }),
  };
}
function assetType(filename: string): { kind: AssetKind; contentType: string } {
  if (filename === "playback.mp4")
    return { kind: "MP4", contentType: "video/mp4" };
  if (filename === "master.m3u8")
    return {
      kind: "HLS_MANIFEST",
      contentType: "application/vnd.apple.mpegurl",
    };
  if (filename.endsWith(".ts"))
    return { kind: "HLS_SEGMENT", contentType: "video/mp2t" };
  if (filename === "poster.jpg")
    return { kind: "POSTER", contentType: "image/jpeg" };
  throw new Error(`Unexpected FFmpeg output ${filename}`);
}

async function processMedia(
  job: Job<MediaProcessingJob>,
  pool: Pool,
): Promise<void> {
  const data = mediaProcessingJobSchema.parse(job.data);
  if (data.processingVersion !== PROCESSING_VERSION)
    throw new Error(`Unsupported processing version ${data.processingVersion}`);
  const existing = await pool.query<{ status: string }>(
    "SELECT status FROM recordings WHERE id = $1 AND workspace_id = $2",
    [data.recordingId, data.workspaceId],
  );
  if (existing.rowCount !== 1)
    throw new Error("Recording not found for processing job");
  if (existing.rows[0]?.status === "READY") {
    await transcriptionQueue.add(
      "transcribe",
      data,
      transcriptionJobOptions(data.recordingId, data.processingVersion),
    );
    return;
  }
  const attempt = await pool.query<{ id: string }>(
    "INSERT INTO recording_processing_attempts (recording_id, processing_version, worker_id, status, started_at) VALUES ($1, $2, $3, 'RUNNING', now()) ON CONFLICT (recording_id, processing_version) DO UPDATE SET worker_id = EXCLUDED.worker_id, status = 'RUNNING', started_at = now(), completed_at = NULL, failure_category = NULL, failure_detail = NULL RETURNING id",
    [
      data.recordingId,
      data.processingVersion,
      process.env.HOSTNAME ?? "media-worker",
    ],
  );
  const attemptId = attempt.rows[0]?.id;
  if (!attemptId) throw new Error("Unable to create processing attempt");
  const workdir = await mkdtemp(join(tmpdir(), "cap-media-"));
  try {
    const { bucket, client } = s3();
    const sourcePath = join(workdir, "source");
    const source = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: data.sourceObjectKey }),
    );
    if (
      !source.Body ||
      typeof (source.Body as NodeJS.ReadableStream).pipe !== "function"
    )
      throw new Error("S3 source object has no readable body");
    await pipeline(
      source.Body as NodeJS.ReadableStream,
      createWriteStream(sourcePath, { flags: "wx" }),
    );
    const metadata = await inspectMedia(sourcePath);
    const outputDirectory = join(workdir, "output");
    await createPlaybackAssets(sourcePath, outputDirectory);
    const files = await readdir(outputDirectory);
    const prefix = `workspaces/${data.workspaceId}/recordings/${data.recordingId}`;
    const assets: Asset[] = files.map((filename) => {
      const type = assetType(filename);
      const category = type.kind === "POSTER" ? "thumbnails" : "playback";
      return {
        ...type,
        objectKey: `${prefix}/${category}/${filename}`,
        filePath: join(outputDirectory, filename),
      };
    });
    for (const asset of assets) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: asset.objectKey,
          Body: createReadStream(asset.filePath),
          ContentType: asset.contentType,
          ServerSideEncryption: process.env.AWS_KMS_KEY_ARN
            ? "aws:kms"
            : "AES256",
          ...(process.env.AWS_KMS_KEY_ARN
            ? { SSEKMSKeyId: process.env.AWS_KMS_KEY_ARN }
            : {}),
        }),
      );
    }
    await pool.query("BEGIN");
    try {
      await pool.query(
        "DELETE FROM recording_assets WHERE recording_id = $1 AND processing_version = $2",
        [data.recordingId, data.processingVersion],
      );
      for (const asset of assets)
        await pool.query(
          "INSERT INTO recording_assets (recording_id, processing_version, kind, object_key, content_type, size_bytes) VALUES ($1, $2, $3, $4, $5, $6)",
          [
            data.recordingId,
            data.processingVersion,
            asset.kind,
            asset.objectKey,
            asset.contentType,
            (await readFile(asset.filePath)).byteLength,
          ],
        );
      await pool.query(
        "UPDATE recording_processing_attempts SET status = 'COMPLETED', completed_at = now(), source_metadata = $2::jsonb, asset_manifest = $3::jsonb WHERE id = $1",
        [
          attemptId,
          JSON.stringify(metadata),
          JSON.stringify(
            assets.map(({ filePath: _filePath, ...asset }) => asset),
          ),
        ],
      );
      await pool.query(
        "UPDATE recordings SET status = 'READY', updated_at = now() WHERE id = $1",
        [data.recordingId],
      );
      await pool.query("COMMIT");
      await transcriptionQueue.add(
        "transcribe",
        data,
        transcriptionJobOptions(data.recordingId, data.processingVersion),
      );
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  } catch (error) {
    await pool.query(
      "UPDATE recording_processing_attempts SET status = 'FAILED', completed_at = now(), failure_category = $2, failure_detail = $3 WHERE id = $1",
      [
        attemptId,
        error instanceof Error ? error.name : "UnknownError",
        error instanceof Error
          ? error.message.slice(0, 4000)
          : "Unknown failure",
      ],
    );
    await pool.query(
      "UPDATE recordings SET status = 'FAILED', updated_at = now() WHERE id = $1 AND status = 'PROCESSING'",
      [data.recordingId],
    );
    throw error;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

const pool = new Pool({ connectionString: required("DATABASE_URL") });
const connection = createRedisConnection(required("REDIS_URL"));
const queue = createMediaProcessingQueue(connection);
const transcriptionQueue = createTranscriptionQueue(connection);
const worker = new Worker<MediaProcessingJob>(
  MEDIA_PROCESSING_QUEUE,
  (job) => processMedia(job, pool),
  {
    connection,
    concurrency: Number(process.env.MEDIA_WORKER_CONCURRENCY ?? "1"),
  },
);
let ready = false;
worker.on("ready", () => {
  ready = true;
});
worker.on("failed", (job, error) =>
  console.error("media job failed", job?.id, error),
);
worker.on("error", (error) => console.error("media worker error", error));
const healthServer = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  response
    .writeHead(ready ? 200 : 503, { "content-type": "application/json" })
    .end(JSON.stringify({ status: ready ? "ok" : "starting" }));
});
healthServer.listen(
  Number(process.env.MEDIA_WORKER_HEALTH_PORT ?? "8081"),
  "0.0.0.0",
);
const outboxTimer = setInterval(() => {
  void dispatchProcessingOutbox(pool, queue).catch((error: unknown) =>
    console.error("outbox dispatch failed", error),
  );
}, 2_000);
void dispatchProcessingOutbox(pool, queue).catch((error: unknown) =>
  console.error("outbox dispatch failed", error),
);
async function shutdown(): Promise<void> {
  clearInterval(outboxTimer);
  await new Promise<void>((resolve, reject) =>
    healthServer.close((error) => (error ? reject(error) : resolve())),
  );
  await worker.close();
  await queue.close();
  await transcriptionQueue.close();
  await connection.quit();
  await pool.end();
}
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
