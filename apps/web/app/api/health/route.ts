import { sql } from "drizzle-orm";
import Redis from "ioredis";
import { db } from "../../../db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 2_000;

let redis: Redis | undefined;

function redisClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL must be configured");
  redis ??= new Redis(url, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  return redis;
}

/** Rejects rather than hanging, so an unreachable dependency fails the probe. */
async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} probe timed out`)),
      PROBE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

async function probe(label: string, work: () => Promise<unknown>) {
  try {
    await withTimeout(work(), label);
    return [label, true] as const;
  } catch (error) {
    // The name alone: a connection error can carry the DSN.
    console.error(
      `health probe failed: ${label}`,
      error instanceof Error ? error.name : "UnknownError",
    );
    return [label, false] as const;
  }
}

/**
 * Reports whether this instance can serve traffic, not merely whether it is
 * running. Deploys gate on it, so a container that has lost Postgres or Redis
 * must answer 503 and be kept out of rotation.
 */
export async function GET() {
  const results = await Promise.all([
    probe("database", () => db().execute(sql`SELECT 1`)),
    probe("redis", () => redisClient().ping()),
  ]);
  const dependencies = Object.fromEntries(
    results.map(([label, healthy]) => [label, healthy ? "ok" : "unreachable"]),
  );
  const healthy = results.every(([, ok]) => ok);

  return Response.json(
    { status: healthy ? "ok" : "degraded", service: "web", dependencies },
    { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
