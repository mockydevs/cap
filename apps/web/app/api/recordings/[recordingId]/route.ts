import { and, eq, ne } from "drizzle-orm";
import { db } from "../../../../db/client";
import { recordingAssets, recordings } from "../../../../db/schema";
import { requireActor } from "../../../../lib/auth/authorization";
import { recordingError } from "../../../../lib/recordings/http";
import { recordingParamsSchema } from "../../../../lib/recordings/validation";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const actor = await requireActor(request);
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    const [recording] = await db()
      .select({
        id: recordings.id,
        ownerId: recordings.ownerId,
        title: recordings.title,
        status: recordings.status,
        sizeBytes: recordings.sizeBytes,
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
    const assets = await db()
      .select({
        kind: recordingAssets.kind,
        contentType: recordingAssets.contentType,
        sizeBytes: recordingAssets.sizeBytes,
      })
      .from(recordingAssets)
      .where(eq(recordingAssets.recordingId, recording.id));
    return Response.json({
      ...recording,
      canManageSharing:
        actor.role === "OWNER" ||
        actor.role === "ADMIN" ||
        recording.ownerId === actor.userId,
      createdAt: recording.createdAt.toISOString(),
      updatedAt: recording.updatedAt.toISOString(),
      assets,
    });
  } catch (error) {
    return recordingError(error);
  }
}
