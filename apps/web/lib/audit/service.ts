import { and, desc, eq, lt, or } from "drizzle-orm";
import { db } from "../../db/client";
import { auditEvents, users } from "../../db/schema";

type Executor = Pick<ReturnType<typeof db>, "insert">;

export async function recordAuditEvent(
  executor: Executor,
  input: {
    workspaceId: string;
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await executor.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    metadata: input.metadata ?? {},
  });
}

export async function listAuditEvents(
  workspaceId: string,
  cursorId: string | undefined,
  limit: number,
) {
  let cursor: { id: string; createdAt: Date } | undefined;
  if (cursorId)
    [cursor] = await db()
      .select({ id: auditEvents.id, createdAt: auditEvents.createdAt })
      .from(auditEvents)
      .where(
        and(eq(auditEvents.id, cursorId), eq(auditEvents.workspaceId, workspaceId)),
      )
      .limit(1);
  const rows = await db()
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      metadata: auditEvents.metadata,
      createdAt: auditEvents.createdAt,
      actorUserId: auditEvents.actorUserId,
      actorEmail: users.email,
      actorDisplayName: users.displayName,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(
      and(
        eq(auditEvents.workspaceId, workspaceId),
        cursor
          ? or(
              lt(auditEvents.createdAt, cursor.createdAt),
              and(
                eq(auditEvents.createdAt, cursor.createdAt),
                lt(auditEvents.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
  };
}
