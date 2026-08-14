import { createReadStream, createWriteStream } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { withTransaction } from "@cap/postgres";
import { createStorageClient, storageWriteEncryption } from "@cap/storage";
import { Worker, type Job } from "bullmq";
import { Pool } from "pg";
import {
  createRedisConnection,
  RENDER_QUEUE,
  renderJobSchema,
  type RenderJob,
} from "@cap/queue";
import {
  compileRenderManifest,
  stableSerializeRenderManifest,
  type FfmpegRenderManifest,
} from "@cap/editor-domain";
import { createHash } from "node:crypto";
import { executeRender } from "./ffmpeg";
const req = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} required`);
  return v;
};
const pool = new Pool({ connectionString: req("DATABASE_URL") });
const redis = createRedisConnection(req("REDIS_URL"));
const s3 = createStorageClient();
const bucket = req("AWS_S3_BUCKET_NAME");
async function run(job: Job<RenderJob>) {
  const d = renderJobSchema.parse(job.data);
  const claimed = await pool.query<{
    manifest: FfmpegRenderManifest;
    recording_id: string;
  }>(
    "UPDATE render_jobs j SET status='PROCESSING',attempt=attempt+1,started_at=now(),error_category=NULL FROM editor_projects p,editor_revisions r WHERE j.id=$1 AND j.workspace_id=$2 AND j.project_id=$3 AND j.revision=$4 AND j.status IN ('QUEUED','FAILED') AND p.id=j.project_id AND r.project_id=j.project_id AND r.revision=j.revision RETURNING j.manifest,p.recording_id",
    [d.renderJobId, d.workspaceId, d.projectId, d.revision],
  );
  if (!claimed.rows[0]) {
    const done = await pool.query(
      "SELECT 1 FROM render_jobs WHERE id=$1 AND status='COMPLETED'",
      [d.renderJobId],
    );
    if (done.rowCount) return;
    throw new Error("Render job unavailable");
  }
  const manifest = claimed.rows[0].manifest;
  const compiledHash = createHash("sha256")
    .update(stableSerializeRenderManifest(manifest))
    .digest("hex");
  const stored = await pool.query<{ manifest_hash: string }>(
    "SELECT manifest_hash FROM render_jobs WHERE id=$1",
    [d.renderJobId],
  );
  if (stored.rows[0]?.manifest_hash !== compiledHash)
    throw new Error("Render manifest hash mismatch");
  const dir = await mkdtemp(join(tmpdir(), "cap-render-"));
  try {
    const assets = await pool.query<{ id: string; object_key: string }>(
      "SELECT id,object_key FROM recording_assets WHERE id=ANY($1::uuid[])",
      [manifest.inputs.map((i) => i.assetId)],
    );
    const paths: string[] = [];
    for (const input of manifest.inputs) {
      const asset = assets.rows.find((a) => a.id === input.assetId);
      if (!asset) throw new Error("Render source asset missing");
      const path = join(dir, `input-${input.index}`);
      const object = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: asset.object_key }),
      );
      await pipeline(
        object.Body as NodeJS.ReadableStream,
        createWriteStream(path),
      );
      paths[input.index] = path;
    }
    const output = join(dir, "export.mp4");
    await executeRender(
      manifest,
      paths,
      output,
      Number(process.env.RENDER_TIMEOUT_MS ?? "1800000"),
      dir,
    );
    const key = `workspaces/${d.workspaceId}/recordings/${claimed.rows[0].recording_id}/exports/${d.renderJobId}.mp4`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(output),
        ContentType: "video/mp4",
        ...storageWriteEncryption(),
      }),
    );
    const size = (await stat(output)).size;
    await withTransaction(pool, async (transaction) => {
      const asset = await transaction.query<{ id: string }>(
        "INSERT INTO recording_assets(recording_id,processing_version,kind,object_key,content_type,size_bytes) VALUES($1,$2,'EXPORT',$3,'video/mp4',$4) RETURNING id",
        [claimed.rows[0]!.recording_id, d.revision, key, size],
      );
      await transaction.query(
        "UPDATE render_jobs SET status='COMPLETED',output_asset_id=$2,completed_at=now() WHERE id=$1",
        [d.renderJobId, asset.rows[0]!.id],
      );
    });
  } catch (e) {
    await pool.query(
      "UPDATE render_jobs SET status='FAILED',error_category=$2,completed_at=now() WHERE id=$1",
      [d.renderJobId, e instanceof Error ? e.name : "UnknownError"],
    );
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
let ready = false;
const worker = new Worker<RenderJob>(RENDER_QUEUE, run, {
  connection: redis,
  concurrency: Number(process.env.RENDER_WORKER_CONCURRENCY ?? "1"),
});
worker.on("ready", () => {
  ready = true;
});
worker.on("error", console.error);
const server = createServer((q, r) =>
  q.url === "/health"
    ? r
        .writeHead(ready ? 200 : 503)
        .end(JSON.stringify({ status: ready ? "ok" : "starting" }))
    : r.writeHead(404).end(),
);
server.listen(
  Number(process.env.RENDER_WORKER_HEALTH_PORT ?? "8083"),
  "0.0.0.0",
);
async function shutdown() {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  // Lets the in-flight render finish so its `finally` removes the scratch
  // directory; BullMQ re-queues anything still running when the deadline hits.
  await worker.close();
  await redis.quit();
  await pool.end();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
