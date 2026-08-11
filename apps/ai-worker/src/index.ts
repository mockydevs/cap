import { createServer } from "node:http";
import { Worker } from "bullmq";
import { Pool } from "pg";
import { KMSClient } from "@aws-sdk/client-kms";
import { AI_QUEUE, createRedisConnection, type AiJob } from "@cap/queue";
import { processJob } from "./process-job";
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
};
const pool = new Pool({ connectionString: required("DATABASE_URL") });
const connection = createRedisConnection(required("REDIS_URL"));
const kms = new KMSClient(
  process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {},
);
let ready = false;
const worker = new Worker<AiJob>(
  AI_QUEUE,
  (job) => processJob(pool, kms, job),
  {
    connection,
    concurrency: Number(process.env.AI_WORKER_CONCURRENCY ?? "2"),
  },
);
worker.on("ready", () => {
  ready = true;
});
worker.on("failed", (job, error) =>
  console.error("AI job failed", job?.id, error.name),
);
const server = createServer((request, response) => {
  if (request.url !== "/health") return void response.writeHead(404).end();
  response
    .writeHead(ready ? 200 : 503, { "content-type": "application/json" })
    .end(JSON.stringify({ status: ready ? "ok" : "starting" }));
});
server.listen(Number(process.env.AI_WORKER_HEALTH_PORT ?? "8084"), "0.0.0.0");
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
