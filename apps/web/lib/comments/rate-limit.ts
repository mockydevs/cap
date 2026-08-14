import { createHash } from "node:crypto";
import Redis from "ioredis";
import { clientAddress } from "../http/client-address";

let redis: Redis | undefined;
export async function enforceCommentRateLimit(request: Request, scope: string) {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("COMMENT_RATE_LIMIT_NOT_CONFIGURED");
  redis ??= new Redis(url, { maxRetriesPerRequest: 1, enableReadyCheck: true });
  const key = `cap:comment:${createHash("sha256")
    .update(`${scope}:${clientAddress(request)}`)
    .digest("hex")}`;
  const count = await redis.eval(
    "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
    1,
    key,
    60,
  );
  if (Number(count) > 20) throw new Error("COMMENT_RATE_LIMITED");
}
