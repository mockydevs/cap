import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { viewEvents, viewSessions } from "../../db/schema";
import { clientAddress } from "../http/client-address";
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
