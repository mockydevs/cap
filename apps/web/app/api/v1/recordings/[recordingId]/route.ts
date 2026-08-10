import { and, eq, ne } from "drizzle-orm";
import { db } from "../../../../../db/client";
import { recordings } from "../../../../../db/schema";
import { requireApiKeyActor } from "../../../../../lib/api-keys/auth";
import { publicApiError } from "../../../../../lib/api-keys/v1-http";
import { recordingParamsSchema } from "../../../../../lib/recordings/validation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const actor = await requireApiKeyActor(request);
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    const [recording] = await db()
      .select({
        id: recordings.id,
        title: recordings.title,
        status: recordings.status,
        visibility: recordings.visibility,
        durationMs: recordings.durationMs,
        width: recordings.width,
        height: recordings.height,
        createdAt: recordings.createdAt,
        updatedAt: recordings.updatedAt,
      })
      .from(recordings)
      .where(
        and(
          eq(recordings.id, recordingId),
          eq(recordings.workspaceId, actor.workspaceId),
          ne(recordings.status, "DELETED"),
        ),
      )
      .limit(1);
    if (!recording)
      return Response.json(
        { error: { code: "RECORDING_NOT_FOUND" } },
        { status: 404 },
      );
    return Response.json({
      ...recording,
      createdAt: recording.createdAt.toISOString(),
      updatedAt: recording.updatedAt.toISOString(),
    });
  } catch (error) {
    return publicApiError(error);
  }
}
