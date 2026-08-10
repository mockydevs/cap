import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { retentionPolicies } from "../../db/schema";
import { recordAuditEvent } from "../audit/service";
import type { Actor } from "../auth/session";
import { deleteRecordingSystem, purgeDeletedRecording } from "../recordings/service";

const DEFAULT_PURGE_GRACE_DAYS = 30;

export async function getRetentionPolicy(workspaceId: string) {
  const [policy] = await db()
    .select({
      recordingRetentionDays: retentionPolicies.recordingRetentionDays,
      deletedRecordingPurgeDays: retentionPolicies.deletedRecordingPurgeDays,
      updatedAt: retentionPolicies.updatedAt,
    })
    .from(retentionPolicies)
    .where(eq(retentionPolicies.workspaceId, workspaceId))
    .limit(1);
  return (
    policy ?? {
      recordingRetentionDays: null,
      deletedRecordingPurgeDays: DEFAULT_PURGE_GRACE_DAYS,
      updatedAt: null,
    }
  );
}

export async function updateRetentionPolicy(
  actor: Actor,
  input: {
    recordingRetentionDays: number | null;
    deletedRecordingPurgeDays: number;
  },
) {
  await db()
    .insert(retentionPolicies)
    .values({
      workspaceId: actor.workspaceId,
      recordingRetentionDays: input.recordingRetentionDays,
      deletedRecordingPurgeDays: input.deletedRecordingPurgeDays,
      updatedBy: actor.userId,
    })
    .onConflictDoUpdate({
      target: retentionPolicies.workspaceId,
      set: {
        recordingRetentionDays: input.recordingRetentionDays,
        deletedRecordingPurgeDays: input.deletedRecordingPurgeDays,
        updatedBy: actor.userId,
        updatedAt: new Date(),
      },
    });
  await recordAuditEvent(db(), {
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    action: "retention_policy.updated",
    targetType: "retention_policy",
    targetId: actor.workspaceId,
    metadata: input,
  });
}

interface AgedOutRecording {
  id: string;
  workspaceId: string;
}

async function findRecordingsPastRetention(): Promise<AgedOutRecording[]> {
  const rows = await db().execute<{ id: string; workspace_id: string }>(sql`
    select r.id, r.workspace_id
    from recordings r
    join retention_policies p on p.workspace_id = r.workspace_id
    where p.recording_retention_days is not null
      and r.status <> 'DELETED'
      and r.created_at < now() - (p.recording_retention_days || ' days')::interval
  `);
  return rows.rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id }));
}

async function findRecordingsPastPurgeGrace(): Promise<string[]> {
  const rows = await db().execute<{ id: string }>(sql`
    select r.id
    from recordings r
    left join retention_policies p on p.workspace_id = r.workspace_id
    where r.deleted_at is not null
      and r.deleted_at < now() - (coalesce(p.deleted_recording_purge_days, ${DEFAULT_PURGE_GRACE_DAYS}) || ' days')::interval
  `);
  return rows.rows.map((row) => row.id);
}

export interface RetentionSweepResult {
  autoDeleted: number;
  purged: number;
}

/**
 * Intended to run on a schedule (see scripts/retention-sweep.ts). Auto-deletes
 * recordings past a workspace's configured retention window, then permanently
 * purges recordings whose soft-delete grace period has elapsed.
 */
export async function runRetentionSweep(): Promise<RetentionSweepResult> {
  const agedOut = await findRecordingsPastRetention();
  for (const recording of agedOut)
    await deleteRecordingSystem(recording.workspaceId, recording.id);

  const purgeable = await findRecordingsPastPurgeGrace();
  for (const recordingIdValue of purgeable)
    await purgeDeletedRecording(recordingIdValue);

  return { autoDeleted: agedOut.length, purged: purgeable.length };
}
