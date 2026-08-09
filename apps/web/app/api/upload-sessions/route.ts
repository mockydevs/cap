import { randomUUID } from "node:crypto";
import { db } from "../../../db/client";
import { recordings, uploadSessions } from "../../../db/schema";
import { requireUploadActor } from "../../../lib/uploads/auth";
import { uploadError } from "../../../lib/uploads/http";
import { createPrivateMultipartUpload } from "../../../lib/uploads/s3";
import { createUploadSchema, UPLOAD_PART_SIZE_BYTES } from "../../../lib/uploads/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const actor = requireUploadActor();
    const input = createUploadSchema.parse(await request.json());
    const recordingId = randomUUID();
    const sessionId = randomUUID();
    const objectKey = `workspaces/${actor.workspaceId}/recordings/${recordingId}/source/recording.webm`;
    const s3UploadId = await createPrivateMultipartUpload(objectKey, input.contentType);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db().transaction(async (transaction) => {
      await transaction.insert(recordings).values({ id: recordingId, workspaceId: actor.workspaceId, ownerId: actor.userId, title: input.title, sourceObjectKey: objectKey, contentType: input.contentType });
      await transaction.insert(uploadSessions).values({ id: sessionId, workspaceId: actor.workspaceId, recordingId, s3UploadId, objectKey, contentType: input.contentType, partSizeBytes: UPLOAD_PART_SIZE_BYTES, expectedSizeBytes: input.sizeBytes, expiresAt });
    });
    return Response.json({ recordingId, sessionId, partSizeBytes: UPLOAD_PART_SIZE_BYTES, expiresAt: expiresAt.toISOString() }, { status: 201 });
  } catch (error) { return uploadError(error); }
}
