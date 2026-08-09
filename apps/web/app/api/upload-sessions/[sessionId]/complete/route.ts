import { and, eq } from "drizzle-orm";
import { db } from "../../../../../db/client";
import { recordings, uploadSessions } from "../../../../../db/schema";
import { requireUploadActor } from "../../../../../lib/uploads/auth";
import { uploadError } from "../../../../../lib/uploads/http";
import { completePrivateMultipartUpload } from "../../../../../lib/uploads/s3";
import { completeUploadSchema, sessionParamsSchema } from "../../../../../lib/uploads/validation";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const actor = requireUploadActor(); const { sessionId } = sessionParamsSchema.parse(await context.params); const input = completeUploadSchema.parse(await request.json());
    const [session] = await db().select().from(uploadSessions).where(and(eq(uploadSessions.id, sessionId), eq(uploadSessions.workspaceId, actor.workspaceId), eq(uploadSessions.status, "ACTIVE")));
    if (!session || session.expiresAt < new Date()) return Response.json({ error: { code: "UPLOAD_SESSION_NOT_FOUND" } }, { status: 404 });
    const uploadedSize = await completePrivateMultipartUpload(session.objectKey, session.s3UploadId, input.parts);
    if (uploadedSize !== session.expectedSizeBytes) {
      return Response.json({ error: { code: "UPLOAD_SIZE_MISMATCH" } }, { status: 409 });
    }
    await db().transaction(async (transaction) => {
      await transaction.update(uploadSessions).set({ status: "COMPLETED", completedAt: new Date() }).where(eq(uploadSessions.id, session.id));
      await transaction.update(recordings).set({ status: "PROCESSING", sizeBytes: session.expectedSizeBytes, updatedAt: new Date() }).where(eq(recordings.id, session.recordingId));
    });
    return Response.json({ recordingId: session.recordingId, status: "PROCESSING" });
  } catch (error) { return uploadError(error); }
}
