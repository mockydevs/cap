import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { apiKeys } from "../../db/schema";
import { AuthenticationError } from "../auth/authorization";
import {
  enforceFixedWindowRateLimit,
  ShareRateLimitError,
} from "../sharing/rate-limit";
import { hashApiKey } from "./service";

export interface ApiKeyActor {
  readonly workspaceId: string;
  readonly apiKeyId: string;
}

export class ApiRateLimitError extends Error {}

/**
 * Public v1 API authentication. Distinct from the session-cookie based
 * `requireActor` used by the app's own internal routes — this is for
 * external integrations authenticating with a long-lived bearer key.
 */
export async function requireApiKeyActor(
  request: Request,
): Promise<ApiKeyActor> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer cap_live_"))
    throw new AuthenticationError("A valid API key bearer token is required");
  const key = header.slice(7);
  const [row] = await db()
    .select({
      id: apiKeys.id,
      workspaceId: apiKeys.workspaceId,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashApiKey(key)))
    .limit(1);
  if (!row || row.revokedAt)
    throw new AuthenticationError("API key is invalid or revoked");
  try {
    await enforceFixedWindowRateLimit(`api-key:${row.id}`, 300, 5 * 60);
  } catch (error) {
    if (error instanceof ShareRateLimitError) throw new ApiRateLimitError();
    throw error;
  }
  void db()
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch((error: unknown) =>
      console.error("failed to record api key last-used timestamp", error),
    );
  return { workspaceId: row.workspaceId, apiKeyId: row.id };
}
