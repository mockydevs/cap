import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { recordings, viewEvents, viewSessions } from "../../db/schema";
import { AuthorizationError } from "../auth/authorization";
import type { Actor } from "../auth/session";
import { clientAddress } from "../http/client-address";
import { canManageRecording } from "../recordings/library-policy";
import { RecordingServiceError } from "../recordings/service";
import { enforceFixedWindowRateLimit } from "../sharing/rate-limit";

const DEDUP_WINDOW_MS = 30 * 60 * 1000;
const GRANT_TTL_SECONDS = 24 * 60 * 60;

export type ViewKind = "WORKSPACE" | "SHARE" | "PUBLIC" | "EMBED";

export class AnalyticsServiceError extends Error {
  readonly code: "ANALYTICS_NOT_CONFIGURED" | "INVALID_VIEW_GRANT";
  readonly status: number;

  constructor(code: AnalyticsServiceError["code"], status: number) {
    super(code);
    this.name = "AnalyticsServiceError";
    this.code = code;
    this.status = status;
  }
}

function secret(): string {
  const value = process.env.ANALYTICS_HASH_SECRET;
  if (!value || value.length < 32)
    throw new AnalyticsServiceError("ANALYTICS_NOT_CONFIGURED", 503);
  return value;
}

function hmac(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("hex");
}

/**
 * The hash a signed-in viewer's sessions are recorded under. Stable across
 * requests, which is what lets the workspace pick up where someone left off.
 */
export function viewerHashForUser(userId: string): string {
  return hmac(`user:${userId}`);
}

export function privacySafeViewerHash(
  request: Request,
  actorUserId: string | undefined,
  now = new Date(),
): string {
  if (actorUserId) return viewerHashForUser(actorUserId);
  const day = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
  const userAgent = (request.headers.get("user-agent") ?? "unknown").slice(
    0,
    512,
  );
  return hmac(`anonymous:${day}:${clientAddress(request)}:${userAgent}`);
}

function issueGrant(sessionId: string, now: Date): string {
  const expiresAt = Math.floor(now.getTime() / 1000) + GRANT_TTL_SECONDS;
  const payload = `${sessionId}.${expiresAt}`;
  const signature = createHmac("sha256", secret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyViewGrant(grant: string, now = new Date()): string {
  const [sessionId, expiryText, suppliedSignature, extra] = grant.split(".");
  if (
    extra ||
    !sessionId ||
    !expiryText ||
    !suppliedSignature ||
    !/^[0-9a-f-]{36}$/.test(sessionId)
  ) {
    throw new AnalyticsServiceError("INVALID_VIEW_GRANT", 401);
  }
  const expiresAt = Number(expiryText);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor(now.getTime() / 1000)
  ) {
    throw new AnalyticsServiceError("INVALID_VIEW_GRANT", 401);
  }
  const expected = createHmac("sha256", secret())
    .update(`${sessionId}.${expiryText}`)
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedSignature, "base64url");
  } catch {
    throw new AnalyticsServiceError("INVALID_VIEW_GRANT", 401);
  }
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new AnalyticsServiceError("INVALID_VIEW_GRANT", 401);
  }
  return sessionId;
}

export async function beginViewSession(input: {
  request: Request;
  recordingId: string;
  workspaceId: string;
  kind: ViewKind;
  actorUserId?: string | undefined;
  shareLinkId?: string | undefined;
}) {
  const now = new Date();
  const viewerHash = privacySafeViewerHash(
    input.request,
    input.actorUserId,
    now,
  );
  const window = Math.floor(now.getTime() / DEDUP_WINDOW_MS);
  const dedupKeyHash = hmac(
    `${input.recordingId}:${viewerHash}:${input.kind}:${input.shareLinkId ?? "none"}:${window}`,
  );
  await enforceFixedWindowRateLimit(`view-start:${dedupKeyHash}`, 30, 60);
  const [session] = await db()
    .insert(viewSessions)
    .values({
      recordingId: input.recordingId,
      workspaceId: input.workspaceId,
      ...(input.shareLinkId ? { shareLinkId: input.shareLinkId } : {}),
      kind: input.kind,
      viewerHash,
      dedupKeyHash,
      firstViewedAt: now,
      lastViewedAt: now,
    })
    .onConflictDoUpdate({
      target: viewSessions.dedupKeyHash,
      set: { lastViewedAt: now },
    })
    .returning({ id: viewSessions.id });
  if (!session)
    throw new AnalyticsServiceError("ANALYTICS_NOT_CONFIGURED", 503);
  return { viewSessionGrant: issueGrant(session.id, now) };
}

export async function recordViewEvent(
  grant: string,
  event: {
    eventId: string;
    kind: "HEARTBEAT" | "ENDED";
    positionMs: number;
    deltaMs: number;
  },
): Promise<void> {
  const sessionId = verifyViewGrant(grant);
  await enforceFixedWindowRateLimit(`view-event:${sessionId}`, 120, 60);
  await db().transaction(async (transaction) => {
    const [inserted] = await transaction
      .insert(viewEvents)
      .values({ viewSessionId: sessionId, ...event })
      .onConflictDoNothing()
      .returning({ id: viewEvents.id });
    if (!inserted) return;
    await transaction
      .update(viewSessions)
      .set({
        lastViewedAt: new Date(),
        maxPositionMs: sql`greatest(${viewSessions.maxPositionMs}, ${event.positionMs})`,
        watchTimeMs: sql`least(${viewSessions.watchTimeMs} + ${event.deltaMs}, greatest(0, extract(epoch from (now() - ${viewSessions.firstViewedAt})) * 1000)::bigint + 30000)`,
        ...(event.kind === "ENDED" ? { completed: true } : {}),
      })
      .where(eq(viewSessions.id, sessionId));
  });
}

export type RecordingEngagement = {
  views: number;
  uniqueViewers: number;
  averageWatchTimeMs: number;
  completionRate: number;
  lastViewedAt: string | null;
  retention: Array<{ percent: number; viewers: number }>;
};

/**
 * Returns privacy-safe aggregate engagement. Raw viewer hashes never leave the
 * database and small workspaces get the same useful shape as large ones.
 */
export async function recordingEngagement(
  actor: Actor,
  targetRecordingId: string,
): Promise<RecordingEngagement> {
  const [recording] = await db()
    .select({
      id: recordings.id,
      ownerId: recordings.ownerId,
      durationMs: recordings.durationMs,
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
    throw new AuthorizationError("Only recording managers can view analytics");

  const summaryRows = await db().execute<{
    views: number;
    unique_viewers: number;
    average_watch_time_ms: number;
    completed_views: number;
    last_viewed_at: Date | string | null;
  }>(sql`
    SELECT
      count(*)::int AS views,
      count(DISTINCT viewer_hash)::int AS unique_viewers,
      coalesce(avg(watch_time_ms), 0)::bigint AS average_watch_time_ms,
      count(*) FILTER (WHERE completed)::int AS completed_views,
      max(last_viewed_at) AS last_viewed_at
    FROM view_sessions
    WHERE recording_id = ${recording.id}
  `);
  const summary = summaryRows.rows[0];
  const views = Number(summary?.views ?? 0);
  const durationMs = Number(recording.durationMs ?? 0);
  const retentionRows =
    durationMs > 0
      ? (
          await db().execute<{ percent: number; viewers: number }>(sql`
          SELECT
            checkpoints.percent::int AS percent,
            count(view_sessions.id)::int AS viewers
          FROM generate_series(0, 100, 10) AS checkpoints(percent)
          LEFT JOIN view_sessions
            ON view_sessions.recording_id = ${recording.id}
           AND (
             checkpoints.percent = 0
             OR view_sessions.completed
             OR view_sessions.max_position_ms >= (${durationMs}::bigint * checkpoints.percent / 100)
           )
          GROUP BY checkpoints.percent
          ORDER BY checkpoints.percent
        `)
        ).rows
      : [];

  return {
    views,
    uniqueViewers: Number(summary?.unique_viewers ?? 0),
    averageWatchTimeMs: Number(summary?.average_watch_time_ms ?? 0),
    completionRate:
      views === 0
        ? 0
        : Math.round((Number(summary?.completed_views ?? 0) / views) * 100),
    lastViewedAt: summary?.last_viewed_at
      ? new Date(summary.last_viewed_at).toISOString()
      : null,
    retention: retentionRows.map((row) => ({
      percent: Number(row.percent),
      viewers: Number(row.viewers),
    })),
  };
}
