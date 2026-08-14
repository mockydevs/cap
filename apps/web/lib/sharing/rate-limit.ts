import Redis from "ioredis";

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

const incrementScript = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return current
`;

export async function enforceFixedWindowRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const current = await connection().eval(
    incrementScript,
    1,
    `cap:rate:${key}`,
    windowSeconds,
  );
  if (Number(current) > limit) throw new ShareRateLimitError();
}

export class ShareRateLimitError extends Error {
  constructor() {
    super("Share password rate limit exceeded");
    this.name = "ShareRateLimitError";
  }
}
