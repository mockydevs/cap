import { and, desc, eq, lt, ne, or } from "drizzle-orm";
import { db } from "../../../db/client";
import { recordings } from "../../../db/schema";
import { requireActor } from "../../../lib/auth/authorization";
import { recordingError } from "../../../lib/recordings/http";
import { recordingListSchema } from "../../../lib/recordings/validation";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    const url = new URL(request.url);
    const input = recordingListSchema.parse({
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
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
        title: recordings.title,
        status: recordings.status,
        sizeBytes: recordings.sizeBytes,
        createdAt: recordings.createdAt,
        updatedAt: recordings.updatedAt,
      })
      .from(recordings)
      .where(
        and(
          eq(recordings.workspaceId, actor.workspaceId),
          ne(recordings.status, "DELETED"),
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
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    });
  } catch (error) {
    return recordingError(error);
  }
}
