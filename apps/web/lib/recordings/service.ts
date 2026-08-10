import { recordingId, workspaceId } from "@cap/domain";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "../../db/client";
import { recordings } from "../../db/schema";
import { recordAuditEvent } from "../audit/service";
import { AuthorizationError } from "../auth/authorization";
import type { Actor } from "../auth/session";
import { uploadStorage } from "../uploads/storage";

export class RecordingServiceError extends Error {
  readonly code: "RECORDING_NOT_FOUND";
  readonly status: number;

  constructor(code: RecordingServiceError["code"], status: number) {
    super(code);
    this.name = "RecordingServiceError";
    this.code = code;
    this.status = status;
  }
}

export async function deleteRecording(actor: Actor, targetRecordingId: string) {
  const [recording] = await db()
    .select({ id: recordings.id, ownerId: recordings.ownerId })
    .from(recordings)
    .where(
      and(
        eq(recordings.id, targetRecordingId),
        eq(recordings.workspaceId, actor.workspaceId),
        ne(recordings.status, "DELETED"),
      ),
    )
    .limit(1);
  if (!recording) throw new RecordingServiceError("RECORDING_NOT_FOUND", 404);
  const canDelete =
    actor.role === "OWNER" ||
    actor.role === "ADMIN" ||
    recording.ownerId === actor.userId;
  if (!canDelete)
    throw new AuthorizationError("Only an owner, admin, or the recording's creator can delete it");
  await db().transaction(async (tx) => {
    await tx
      .update(recordings)
      .set({ status: "DELETED", deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(recordings.id, recording.id));
    await recordAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "recording.deleted",
      targetType: "recording",
      targetId: recording.id,
    });
  });
}

/**
 * Permanently removes a soft-deleted recording's object-storage assets and
 * database row. Irreversible — only the retention sweep calls this, after the
 * configured grace period has elapsed.
 */
export async function purgeDeletedRecording(recordingIdValue: string) {
  const [recording] = await db()
    .select({
      id: recordings.id,
      workspaceId: recordings.workspaceId,
      deletedAt: recordings.deletedAt,
    })
    .from(recordings)
    .where(
      and(eq(recordings.id, recordingIdValue), isNotNull(recordings.deletedAt)),
    )
    .limit(1);
  if (!recording) return;
  await uploadStorage().deleteRecordingObjects({
    workspaceId: workspaceId(recording.workspaceId),
    recordingId: recordingId(recording.id),
  });
  await db().transaction(async (tx) => {
    await tx.delete(recordings).where(eq(recordings.id, recording.id));
    await recordAuditEvent(tx, {
      workspaceId: recording.workspaceId,
      actorUserId: null,
      action: "recording.purged",
      targetType: "recording",
      targetId: recording.id,
    });
  });
}

/** System-initiated soft delete for the retention sweep; no actor to authorize against. */
export async function deleteRecordingSystem(
  targetWorkspaceId: string,
  targetRecordingId: string,
) {
  await db().transaction(async (tx) => {
    await tx
      .update(recordings)
      .set({ status: "DELETED", deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(recordings.id, targetRecordingId),
          eq(recordings.workspaceId, targetWorkspaceId),
          ne(recordings.status, "DELETED"),
        ),
      );
    await recordAuditEvent(tx, {
      workspaceId: targetWorkspaceId,
      actorUserId: null,
      action: "recording.retention_auto_deleted",
      targetType: "recording",
      targetId: targetRecordingId,
    });
  });
}
