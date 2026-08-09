import { createHash } from "node:crypto";
import Redis from "ioredis";

const WINDOW_SECONDS = 15 * 60;
let redis: Redis | undefined;

function connection(): Redis {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("SHARE_RATE_LIMIT_NOT_CONFIGURED");
  redis ??= new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });
  return redis;
}

function requestAddress(request: Request): string {
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  return forwarded || "unknown";
}

const incrementScript = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return current
`;

/** Fails closed so password shares never become unbounded when Redis is unavailable. */
export async function enforceSharePasswordRateLimit(
  request: Request,
  tokenHash: string,
): Promise<void> {
  const addressHash = createHash("sha256")
    .update(requestAddress(request))
    .digest("hex");
  const client = connection();
  const [perAddress, perLink] = await Promise.all([
    client.eval(
      incrementScript,
      1,
      `cap:share-password:${tokenHash}:${addressHash}`,
      WINDOW_SECONDS,
    ),
    client.eval(
      incrementScript,
      1,
      `cap:share-password:${tokenHash}:all`,
      WINDOW_SECONDS,
    ),
  ]);
  if (Number(perAddress) > 10 || Number(perLink) > 100) {
    throw new ShareRateLimitError();
  }
}

export class ShareRateLimitError extends Error {
  constructor() {
    super("Share password rate limit exceeded");
    this.name = "ShareRateLimitError";
  }
}
