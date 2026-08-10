import { createServer } from "node:http";
import { KMSClient } from "@aws-sdk/client-kms";
import {
  createRedisConnection,
  createWebhookDeliveryQueue,
  webhookDeliveryJobSchema,
  type WebhookDeliveryJob,
} from "@cap/queue";
import { Worker, type Job } from "bullmq";
import { Pool } from "pg";
import { deliverWebhook } from "./delivery";
import { dispatchWebhookOutbox } from "./outbox";

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
const queue = createWebhookDeliveryQueue(connection);

async function processJob(job: Job<WebhookDeliveryJob>) {
  const data = webhookDeliveryJobSchema.parse(job.data);
  await deliverWebhook(pool, kms, data.deliveryId);
}

let ready = false;
const worker = new Worker<WebhookDeliveryJob>(queue.name, processJob, {
  connection,
  concurrency: Number(process.env.WEBHOOK_WORKER_CONCURRENCY ?? "4"),
});
worker.on("ready", () => {
  ready = true;
});
worker.on("failed", (job, error) =>
  console.error("webhook delivery failed", job?.id, error.name),
);
worker.on("error", (error) => console.error("webhook worker error", error));

const server = createServer((request, response) => {
  if (request.url !== "/health") return void response.writeHead(404).end();
  response
    .writeHead(ready ? 200 : 503, { "content-type": "application/json" })
    .end(JSON.stringify({ status: ready ? "ok" : "starting" }));
});
server.listen(
  Number(process.env.WEBHOOK_WORKER_HEALTH_PORT ?? "8085"),
  "0.0.0.0",
);

const outboxTimer = setInterval(() => {
  void dispatchWebhookOutbox(pool, queue).catch((error: unknown) =>
    console.error("webhook outbox dispatch failed", error),
  );
}, 2_000);
void dispatchWebhookOutbox(pool, queue).catch((error: unknown) =>
  console.error("webhook outbox dispatch failed", error),
);

async function shutdown(): Promise<void> {
  clearInterval(outboxTimer);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await worker.close();
  await connection.quit();
  await pool.end();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
