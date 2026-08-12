import { recordingId, workspaceId } from "@cap/domain";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { recordingStars, recordings } from "../../db/schema";
import { recordAuditEvent } from "../audit/service";
import { AuthorizationError } from "../auth/authorization";
import type { Actor } from "../auth/session";
import { uploadStorage } from "../uploads/storage";
import { emitWebhookEvent } from "../webhooks/service";
import { canManageRecording, statusAfterRestore } from "./library-policy";

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
    .select({
      id: recordings.id,
      ownerId: recordings.ownerId,
      status: recordings.status,
    })
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
  if (!canManageRecording(actor, recording.ownerId))
    throw new AuthorizationError("Only an owner, admin, or the recording's creator can delete it");
  await db().transaction(async (tx) => {
    await tx
      .update(recordings)
      .set({
        status: "DELETED",
        previousStatus: recording.status,
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(recordings.id, recording.id));
    await recordAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "recording.deleted",
      targetType: "recording",
      targetId: recording.id,
    });
    await emitWebhookEvent(tx, {
      event: "recording.deleted",
      workspaceId: actor.workspaceId,
      aggregateId: recording.id,
      payload: { recordingId: recording.id },
    });
  });
}

export async function setRecordingStar(
  actor: Actor,
  targetRecordingId: string,
  starred: boolean,
) {
  const [recording] = await db()
    .select({ id: recordings.id })
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

  if (starred) {
    await db()
      .insert(recordingStars)
      .values({
        userId: actor.userId,
        recordingId: recording.id,
        workspaceId: actor.workspaceId,
      })
      .onConflictDoNothing();
  } else {
    await db()
      .delete(recordingStars)
      .where(
        and(
          eq(recordingStars.userId, actor.userId),
          eq(recordingStars.recordingId, recording.id),
        ),
      );
  }
}

export async function restoreRecording(actor: Actor, targetRecordingId: string) {
  const [recording] = await db()
    .select({
      id: recordings.id,
      ownerId: recordings.ownerId,
      previousStatus: recordings.previousStatus,
    })
    .from(recordings)
    .where(
      and(
        eq(recordings.id, targetRecordingId),
        eq(recordings.workspaceId, actor.workspaceId),
        eq(recordings.status, "DELETED"),
      ),
    )
    .limit(1);
  if (!recording) throw new RecordingServiceError("RECORDING_NOT_FOUND", 404);
  if (!canManageRecording(actor, recording.ownerId))
    throw new AuthorizationError(
      "Only an owner, admin, or the recording's creator can restore it",
    );

  const restoredStatus = statusAfterRestore(recording.previousStatus);
  await db().transaction(async (tx) => {
    await tx
      .update(recordings)
      .set({
        status: restoredStatus,
        previousStatus: null,
        deletedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(recordings.id, recording.id));
    await recordAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "recording.restored",
      targetType: "recording",
      targetId: recording.id,
    });
  });
}

export async function purgeRecording(actor: Actor, targetRecordingId: string) {
  const [recording] = await db()
    .select({
      id: recordings.id,
      ownerId: recordings.ownerId,
      workspaceId: recordings.workspaceId,
    })
    .from(recordings)
    .where(
      and(
        eq(recordings.id, targetRecordingId),
        eq(recordings.workspaceId, actor.workspaceId),
        eq(recordings.status, "DELETED"),
        isNotNull(recordings.deletedAt),
      ),
    )
    .limit(1);
  if (!recording) throw new RecordingServiceError("RECORDING_NOT_FOUND", 404);
  if (!canManageRecording(actor, recording.ownerId))
    throw new AuthorizationError(
      "Only an owner, admin, or the recording's creator can permanently delete it",
    );

  await uploadStorage().deleteRecordingObjects({
    workspaceId: workspaceId(recording.workspaceId),
    recordingId: recordingId(recording.id),
  });
  await db().transaction(async (tx) => {
    await tx.delete(recordings).where(eq(recordings.id, recording.id));
    await recordAuditEvent(tx, {
      workspaceId: recording.workspaceId,
      actorUserId: actor.userId,
      action: "recording.purged",
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
      .set({
        status: "DELETED",
        previousStatus: sql`${recordings.status}`,
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
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
    await emitWebhookEvent(tx, {
      event: "recording.deleted",
      workspaceId: targetWorkspaceId,
      aggregateId: targetRecordingId,
      payload: { recordingId: targetRecordingId, reason: "retention_policy" },
    });
  });
}
