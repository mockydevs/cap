import { and, desc, eq, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "../../../db/client";
import { recordingStars, recordings, users } from "../../../db/schema";
import { requireActor } from "../../../lib/auth/authorization";
import { recordingError } from "../../../lib/recordings/http";
import { canManageRecording } from "../../../lib/recordings/library-policy";
import { recordingListSchema } from "../../../lib/recordings/validation";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    const url = new URL(request.url);
    const input = recordingListSchema.parse({
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      view: url.searchParams.get("view") ?? undefined,
    });
    let cursor: { id: string; createdAt: Date } | undefined;
    if (input.cursor)
      [cursor] = await db()
        .select({ id: recordings.id, createdAt: recordings.createdAt })
        .from(recordings)
        .where(
          and(
            eq(recordings.id, input.cursor),
            eq(recordings.workspaceId, actor.workspaceId),
          ),
        )
        .limit(1);
    const rows = await db()
      .select({
        id: recordings.id,
        ownerId: recordings.ownerId,
        ownerName: users.displayName,
        title: recordings.title,
        status: recordings.status,
        previousStatus: recordings.previousStatus,
        visibility: recordings.visibility,
        sizeBytes: recordings.sizeBytes,
        createdAt: recordings.createdAt,
        updatedAt: recordings.updatedAt,
        deletedAt: recordings.deletedAt,
        isStarred: sql<boolean>`${recordingStars.recordingId} is not null`,
      })
      .from(recordings)
      .innerJoin(users, eq(users.id, recordings.ownerId))
      .leftJoin(
        recordingStars,
        and(
          eq(recordingStars.recordingId, recordings.id),
          eq(recordingStars.userId, actor.userId),
          eq(recordingStars.workspaceId, actor.workspaceId),
        ),
      )
      .where(
        and(
          eq(recordings.workspaceId, actor.workspaceId),
          input.view === "trash"
            ? eq(recordings.status, "DELETED")
            : ne(recordings.status, "DELETED"),
          input.view === "trash" &&
            actor.role !== "OWNER" &&
            actor.role !== "ADMIN"
            ? eq(recordings.ownerId, actor.userId)
            : undefined,
          input.view === "shared"
            ? ne(recordings.ownerId, actor.userId)
            : undefined,
          input.view === "starred"
            ? isNotNull(recordingStars.recordingId)
            : undefined,
          cursor
            ? or(
                lt(recordings.createdAt, cursor.createdAt),
                and(
                  eq(recordings.createdAt, cursor.createdAt),
                  lt(recordings.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(recordings.createdAt), desc(recordings.id))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit);
    return Response.json({
      items: items.map((item) => ({
        ...item,
        canDelete: canManageRecording(actor, item.ownerId),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        deletedAt: item.deletedAt?.toISOString() ?? null,
      })),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    });
  } catch (error) {
    return recordingError(error);
  }
}
