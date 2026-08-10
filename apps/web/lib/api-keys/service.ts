import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { apiKeys } from "../../db/schema";
import { recordAuditEvent } from "../audit/service";
import type { Actor } from "../auth/session";

const KEY_PREFIX = "cap_live_";

export class ApiKeyServiceError extends Error {
  readonly code: "API_KEY_NOT_FOUND";
  readonly status: number;

  constructor(code: ApiKeyServiceError["code"], status: number) {
    super(code);
    this.name = "ApiKeyServiceError";
    this.code = code;
    this.status = status;
  }
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function generateApiKey(): { key: string; prefix: string } {
  const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { key, prefix: key.slice(0, KEY_PREFIX.length + 8) };
}

export async function listApiKeys(workspaceId: string) {
  return db()
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.workspaceId, workspaceId))
    .orderBy(desc(apiKeys.createdAt));
}

export async function createApiKey(actor: Actor, name: string) {
  const { key, prefix } = generateApiKey();
  return db().transaction(async (tx) => {
    const [created] = await tx
      .insert(apiKeys)
      .values({
        workspaceId: actor.workspaceId,
        name,
        keyHash: hashApiKey(key),
        keyPrefix: prefix,
        createdBy: actor.userId,
      })
      .returning({ id: apiKeys.id });
    await recordAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "api_key.created",
      targetType: "api_key",
      targetId: created!.id,
      metadata: { name },
    });
    return { id: created!.id, key };
  });
}

export async function revokeApiKey(actor: Actor, id: string) {
  return db().transaction(async (tx) => {
    const [revoked] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, id),
          eq(apiKeys.workspaceId, actor.workspaceId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning({ id: apiKeys.id });
    if (!revoked) throw new ApiKeyServiceError("API_KEY_NOT_FOUND", 404);
    await recordAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "api_key.revoked",
      targetType: "api_key",
      targetId: id,
    });
  });
}
