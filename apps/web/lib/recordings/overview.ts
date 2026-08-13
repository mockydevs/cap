import { and, count, desc, eq, gt, ne, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { recordings, transcripts, users, viewSessions } from "../../db/schema";
import { AnalyticsServiceError, viewerHashForUser } from "../analytics/service";
import type { Actor } from "../auth/session";

/** Below this, a view reads as a glance rather than something to resume. */
const RESUMABLE_AFTER_MS = 15_000;

export type OverviewFeature = {
  id: string;
  title: string;
  ownerName: string;
  createdAt: string;
  durationMs: number | null;
  views: number;
  /** Where this viewer stopped, or null when they have not started it. */
  resumeAtMs: number | null;
};

export type WorkspaceOverview = {
  stats: {
    recordings: number;
    views: number;
    transcribed: number;
    storageBytes: number;
  };
  featured: OverviewFeature | null;
};

const liveRecording = (workspaceId: string) =>
  and(
    eq(recordings.workspaceId, workspaceId),
    ne(recordings.status, "DELETED"),
  );

async function countViews(workspaceId: string): Promise<number> {
  const [row] = await db()
    .select({ value: count() })
    .from(viewSessions)
    .where(eq(viewSessions.workspaceId, workspaceId));
  return row?.value ?? 0;
}

async function recordingTotals(workspaceId: string) {
  const [row] = await db()
    .select({
      recordings: count(),
      storageBytes: sql<number>`coalesce(sum(${recordings.sizeBytes}), 0)::bigint`,
    })
    .from(recordings)
    .where(liveRecording(workspaceId));
  return {
    recordings: row?.recordings ?? 0,
    storageBytes: Number(row?.storageBytes ?? 0),
  };
}

async function countTranscribed(workspaceId: string): Promise<number> {
  const [row] = await db()
    .select({ value: sql<number>`count(distinct ${transcripts.recordingId})` })
    .from(transcripts)
    .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
    .where(liveRecording(workspaceId));
  return Number(row?.value ?? 0);
}

/**
 * The recording this viewer left unfinished, most recently watched first.
 * Absent when analytics is not configured — the workspace still has a
 * summary to show, just no resume point.
 */
async function resumable(actor: Actor): Promise<OverviewFeature | null> {
  let viewerHash: string;
  try {
    viewerHash = viewerHashForUser(actor.userId);
  } catch (error) {
    if (error instanceof AnalyticsServiceError) return null;
    throw error;
  }
  const [row] = await db()
    .select({
      id: recordings.id,
      title: recordings.title,
      ownerName: users.displayName,
      createdAt: recordings.createdAt,
      durationMs: recordings.durationMs,
      resumeAtMs: viewSessions.maxPositionMs,
    })
    .from(viewSessions)
    .innerJoin(recordings, eq(recordings.id, viewSessions.recordingId))
    .innerJoin(users, eq(users.id, recordings.ownerId))
    .where(
      and(
        eq(viewSessions.workspaceId, actor.workspaceId),
        eq(viewSessions.viewerHash, viewerHash),
        eq(viewSessions.completed, false),
        gt(viewSessions.maxPositionMs, RESUMABLE_AFTER_MS),
        eq(recordings.status, "READY"),
      ),
    )
    .orderBy(desc(viewSessions.lastViewedAt))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    views: await countRecordingViews(row.id),
  };
}

async function latestReady(
  workspaceId: string,
): Promise<OverviewFeature | null> {
  const [row] = await db()
    .select({
      id: recordings.id,
      title: recordings.title,
      ownerName: users.displayName,
      createdAt: recordings.createdAt,
      durationMs: recordings.durationMs,
    })
    .from(recordings)
    .innerJoin(users, eq(users.id, recordings.ownerId))
    .where(
      and(
        eq(recordings.workspaceId, workspaceId),
        eq(recordings.status, "READY"),
      ),
    )
    .orderBy(desc(recordings.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    views: await countRecordingViews(row.id),
    resumeAtMs: null,
  };
}

async function countRecordingViews(recordingIdValue: string): Promise<number> {
  const [row] = await db()
    .select({ value: count() })
    .from(viewSessions)
    .where(eq(viewSessions.recordingId, recordingIdValue));
  return row?.value ?? 0;
}

export async function workspaceOverview(
  actor: Actor,
): Promise<WorkspaceOverview> {
  const [totals, views, transcribed, resumeFeature] = await Promise.all([
    recordingTotals(actor.workspaceId),
    countViews(actor.workspaceId),
    countTranscribed(actor.workspaceId),
    resumable(actor),
  ]);
  return {
    stats: {
      recordings: totals.recordings,
      views,
      transcribed,
      storageBytes: totals.storageBytes,
    },
    featured: resumeFeature ?? (await latestReady(actor.workspaceId)),
  };
}
