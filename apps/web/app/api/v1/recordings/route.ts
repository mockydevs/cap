import { and, desc, eq, lt, ne, or } from "drizzle-orm";
import { db } from "../../../../db/client";
import { recordings } from "../../../../db/schema";
import { requireApiKeyActor } from "../../../../lib/api-keys/auth";
import { publicApiError } from "../../../../lib/api-keys/v1-http";
import { recordingListSchema } from "../../../../lib/recordings/validation";

export const runtime = "nodejs";

/** Public, API-key authenticated, read-only. See docs/PUBLIC_API.md. */
export async function GET(request: Request) {
  try {
    const actor = await requireApiKeyActor(request);
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
        visibility: recordings.visibility,
        durationMs: recordings.durationMs,
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
    const items = rows.slice(0, input.limit);
    return Response.json({
      items: items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
      nextCursor: rows.length > input.limit ? (items.at(-1)?.id ?? null) : null,
    });
  } catch (error) {
    return publicApiError(error);
  }
}
