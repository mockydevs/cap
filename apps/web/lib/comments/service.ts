import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { db } from "../../db/client";
import { commentReactions, comments, recordings, users } from "../../db/schema";
import type { Actor } from "../auth/session";
import { authorizeSharePlayback } from "../sharing/service";

type Identity =
  | { actor: Actor; actorKeyHash: string }
  | { guestName: string; guestKeyHash: string; actorKeyHash: string };
export class CommentError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const memberIdentity = (actor: Actor): Identity => ({
  actor,
  actorKeyHash: digest(`user:${actor.userId}`),
});
export async function guestIdentity(
  request: Request,
  token: string,
  password: string | undefined,
  guestName: string | undefined,
  viewerKey: string | undefined,
) {
  if (!guestName || !viewerKey)
    throw new CommentError("GUEST_IDENTITY_REQUIRED", 400);
  const playback = await authorizeSharePlayback(request, token, password);
  const guestKeyHash = digest(`share:${token}:${viewerKey}`);
  return {
    recordingId: playback.recordingId,
    identity: {
      guestName,
      guestKeyHash,
      actorKeyHash: guestKeyHash,
    } satisfies Identity,
  };
}
async function requireRecording(recordingId: string, identity: Identity) {
  const [recording] = await db()
    .select({ id: recordings.id, workspaceId: recordings.workspaceId })
    .from(recordings)
    .where(
      and(
        eq(recordings.id, recordingId),
        "actor" in identity
          ? eq(recordings.workspaceId, identity.actor.workspaceId)
          : undefined,
      ),
    )
    .limit(1);
  if (!recording) throw new CommentError("RECORDING_NOT_FOUND", 404);
  return recording;
}
export async function listComments(
  recordingId: string,
  identity: Identity,
  cursor: Date | undefined,
  limit: number,
) {
  await requireRecording(recordingId, identity);
  const rows = await db()
    .select({
      id: comments.id,
      body: comments.body,
      timestampMs: comments.timestampMs,
      authorUserId: comments.authorUserId,
      authorName: users.displayName,
      guestName: comments.guestName,
      guestKeyHash: comments.guestKeyHash,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
    })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.authorUserId))
    .where(
      and(
        eq(comments.recordingId, recordingId),
        isNull(comments.deletedAt),
        cursor ? lt(comments.createdAt, cursor) : undefined,
      ),
    )
    .orderBy(desc(comments.createdAt))
    .limit(limit + 1);
  const ids = rows.map((row) => row.id);
  const reactions = ids.length
    ? await db()
        .select()
        .from(commentReactions)
        .where(inArray(commentReactions.commentId, ids))
    : [];
  const items = rows.slice(0, limit).map((row) => ({
    id: row.id,
    body: row.body,
    timestampMs: row.timestampMs,
    authorName: row.authorName ?? row.guestName ?? "Former member",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canEdit:
      "actor" in identity
        ? row.authorUserId === identity.actor.userId ||
          identity.actor.role === "OWNER" ||
          identity.actor.role === "ADMIN"
        : row.guestKeyHash === identity.guestKeyHash,
    reactions: reactions
      .filter((item) => item.commentId === row.id)
      .reduce<Record<string, { count: number; reacted: boolean }>>(
        (all, item) => ({
          ...all,
          [item.emoji]: {
            count: (all[item.emoji]?.count ?? 0) + 1,
            reacted:
              all[item.emoji]?.reacted === true ||
              item.actorKeyHash === identity.actorKeyHash,
          },
        }),
        {},
      ),
  }));
  return {
    items,
    nextCursor: rows.length > limit ? (items.at(-1)?.createdAt ?? null) : null,
  };
}
export async function createComment(
  recordingId: string,
  identity: Identity,
  body: string,
  timestampMs: number,
) {
  const recording = await requireRecording(recordingId, identity);
  const [created] = await db()
    .insert(comments)
    .values({
      workspaceId: recording.workspaceId,
      recordingId,
      body,
      timestampMs,
      ...("actor" in identity
        ? { authorUserId: identity.actor.userId }
        : {
            guestName: identity.guestName,
            guestKeyHash: identity.guestKeyHash,
          }),
    })
    .returning({ id: comments.id });
  return created!;
}
export async function changeComment(
  recordingId: string,
  commentId: string,
  identity: Identity,
  body?: string,
) {
  await requireRecording(recordingId, identity);
  const [comment] = await db()
    .select()
    .from(comments)
    .where(
      and(
        eq(comments.id, commentId),
        eq(comments.recordingId, recordingId),
        isNull(comments.deletedAt),
      ),
    )
    .limit(1);
  const allowed =
    comment &&
    ("actor" in identity
      ? comment.authorUserId === identity.actor.userId ||
        identity.actor.role === "OWNER" ||
        identity.actor.role === "ADMIN"
      : comment.guestKeyHash === identity.guestKeyHash);
  if (!allowed) throw new CommentError("COMMENT_NOT_FOUND", 404);
  await db()
    .update(comments)
    .set(
      body === undefined
        ? { deletedAt: new Date(), updatedAt: new Date() }
        : { body, updatedAt: new Date() },
    )
    .where(eq(comments.id, commentId));
}
export async function setReaction(
  recordingId: string,
  commentId: string,
  identity: Identity,
  emoji: string,
  active: boolean,
) {
  await requireRecording(recordingId, identity);
  const [comment] = await db()
    .select({ id: comments.id })
    .from(comments)
    .where(
      and(
        eq(comments.id, commentId),
        eq(comments.recordingId, recordingId),
        isNull(comments.deletedAt),
      ),
    )
    .limit(1);
  if (!comment) throw new CommentError("COMMENT_NOT_FOUND", 404);
  if (active)
    await db()
      .insert(commentReactions)
      .values({ commentId, actorKeyHash: identity.actorKeyHash, emoji })
      .onConflictDoNothing();
  else
    await db()
      .delete(commentReactions)
      .where(
        and(
          eq(commentReactions.commentId, commentId),
          eq(commentReactions.actorKeyHash, identity.actorKeyHash),
          eq(commentReactions.emoji, emoji),
        ),
      );
}
