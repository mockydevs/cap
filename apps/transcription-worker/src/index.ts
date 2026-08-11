import { createServer } from "node:http";
import { Worker } from "bullmq";
import { Pool } from "pg";
import {
  createRedisConnection,
  TRANSCRIPTION_QUEUE,
  type TranscriptionJob,
} from "@cap/queue";
import { processJob } from "./process-job";
import { providerFromEnvironment } from "./provider";
import { PostgresTranscriptPersistence } from "./persistence";
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
};
const pool = new Pool({ connectionString: required("DATABASE_URL") });
const connection = createRedisConnection(required("REDIS_URL"));
const provider = providerFromEnvironment();
const persistence = new PostgresTranscriptPersistence(pool);
let ready = false;
const worker = new Worker<TranscriptionJob>(
  TRANSCRIPTION_QUEUE,
  (job) => processJob(pool, provider, persistence, job),
  {
    connection,
    concurrency: Number(process.env.TRANSCRIPTION_WORKER_CONCURRENCY ?? "2"),
  },
);
worker.on("ready", () => {
  ready = true;
});
worker.on("failed", (job, error) =>
  console.error("transcription failed", job?.id, error),
);
worker.on("error", (error) =>
  console.error("transcription worker error", error),
);
const server = createServer((request, response) => {
  if (request.url !== "/health") return void response.writeHead(404).end();
  response
    .writeHead(ready ? 200 : 503, { "content-type": "application/json" })
    .end(JSON.stringify({ status: ready ? "ok" : "starting" }));
});
server.listen(
  Number(process.env.TRANSCRIPTION_WORKER_HEALTH_PORT ?? "8082"),
  "0.0.0.0",
);
async function shutdown() {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await worker.close();
  await connection.quit();
  await pool.end();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
