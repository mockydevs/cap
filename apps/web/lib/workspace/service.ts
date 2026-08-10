import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { users, workspaceInvitations, workspaceMembers } from "../../db/schema";
import { recordAuditEvent } from "../audit/service";
import { AuthorizationError } from "../auth/authorization";
import type { Actor } from "../auth/session";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class WorkspaceServiceError extends Error {
  readonly code:
    | "MEMBER_NOT_FOUND"
    | "CANNOT_REMOVE_LAST_OWNER"
    | "CANNOT_DEMOTE_LAST_OWNER"
    | "INVITATION_NOT_FOUND"
    | "INVITATION_EXPIRED"
    | "INVITATION_EMAIL_MISMATCH"
    | "ALREADY_A_MEMBER";
  readonly status: number;

  constructor(code: WorkspaceServiceError["code"], status: number) {
    super(code);
    this.name = "WorkspaceServiceError";
    this.code = code;
    this.status = status;
  }
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function ownerCount(workspaceId: string, tx = db()) {
  const owners = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, "OWNER"),
      ),
    );
  return owners.length;
}

export async function listMembers(workspaceId: string) {
  return db()
    .select({
      userId: workspaceMembers.userId,
      email: users.email,
      displayName: users.displayName,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.createdAt));
}

export async function updateMemberRole(
  actor: Actor,
  targetUserId: string,
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER",
) {
  if (actor.role !== "OWNER" && role === "OWNER")
    throw new AuthorizationError("Only an owner can grant ownership");
  return db().transaction(async (tx) => {
    const [target] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, actor.workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .limit(1);
    if (!target) throw new WorkspaceServiceError("MEMBER_NOT_FOUND", 404);
    if (target.role === "OWNER" && actor.role !== "OWNER")
      throw new AuthorizationError("Only an owner can change an owner's role");
    if (
      target.role === "OWNER" &&
      role !== "OWNER" &&
      (await ownerCount(actor.workspaceId, tx)) <= 1
    )
      throw new WorkspaceServiceError("CANNOT_DEMOTE_LAST_OWNER", 409);
    await tx
      .update(workspaceMembers)
      .set({ role })
      .where(
        and(
          eq(workspaceMembers.workspaceId, actor.workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      );
    await recordAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "workspace_member.role_changed",
      targetType: "user",
      targetId: targetUserId,
      metadata: { from: target.role, to: role },
    });
  });
}

export async function removeMember(actor: Actor, targetUserId: string) {
  return db().transaction(async (tx) => {
    const [target] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, actor.workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .limit(1);
    if (!target) throw new WorkspaceServiceError("MEMBER_NOT_FOUND", 404);
    if (target.role === "OWNER" && actor.role !== "OWNER")
      throw new AuthorizationError("Only an owner can remove an owner");
    if (target.role === "OWNER" && (await ownerCount(actor.workspaceId, tx)) <= 1)
      throw new WorkspaceServiceError("CANNOT_REMOVE_LAST_OWNER", 409);
    await tx
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, actor.workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      );
    await recordAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "workspace_member.removed",
      targetType: "user",
      targetId: targetUserId,
      metadata: { role: target.role },
    });
  });
}

export async function listInvitations(workspaceId: string) {
  return db()
    .select({
      id: workspaceInvitations.id,
      email: workspaceInvitations.email,
      role: workspaceInvitations.role,
      createdAt: workspaceInvitations.createdAt,
      expiresAt: workspaceInvitations.expiresAt,
    })
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        isNull(workspaceInvitations.acceptedAt),
        isNull(workspaceInvitations.revokedAt),
        gt(workspaceInvitations.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(workspaceInvitations.createdAt));
}

/**
 * Adds an existing user directly (no email transport exists to deliver a
 * verification link) or issues an invitation token an admin can share
 * out-of-band for an email with no matching account yet.
 */
export async function inviteMember(
  actor: Actor,
  input: { email: string; role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" },
) {
  return db().transaction(async (tx) => {
    const [existingUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (existingUser) {
      const [existingMembership] = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, actor.workspaceId),
            eq(workspaceMembers.userId, existingUser.id),
          ),
        )
        .limit(1);
      if (existingMembership)
        throw new WorkspaceServiceError("ALREADY_A_MEMBER", 409);
      await tx.insert(workspaceMembers).values({
        workspaceId: actor.workspaceId,
        userId: existingUser.id,
        role: input.role,
      });
      await recordAuditEvent(tx, {
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        action: "workspace_member.added",
        targetType: "user",
        targetId: existingUser.id,
        metadata: { role: input.role },
      });
      return { status: "ADDED" as const, userId: existingUser.id };
    }
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    await tx.insert(workspaceInvitations).values({
      id,
      workspaceId: actor.workspaceId,
      email: input.email,
      role: input.role,
      tokenHash: hashInvitationToken(token),
      invitedBy: actor.userId,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    });
    await recordAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "workspace_invitation.created",
      targetType: "workspace_invitation",
      targetId: id,
      metadata: { email: input.email, role: input.role },
    });
    return { status: "INVITED" as const, invitationId: id, token };
  });
}

export async function revokeInvitation(actor: Actor, invitationId: string) {
  const [updated] = await db()
    .update(workspaceInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(workspaceInvitations.id, invitationId),
        eq(workspaceInvitations.workspaceId, actor.workspaceId),
        isNull(workspaceInvitations.acceptedAt),
        isNull(workspaceInvitations.revokedAt),
      ),
    )
    .returning({ id: workspaceInvitations.id });
  if (!updated) throw new WorkspaceServiceError("INVITATION_NOT_FOUND", 404);
  await recordAuditEvent(db(), {
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    action: "workspace_invitation.revoked",
    targetType: "workspace_invitation",
    targetId: invitationId,
  });
}

export async function acceptInvitation(
  acceptingUser: { userId: string; email: string },
  token: string,
) {
  return db().transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.tokenHash, hashInvitationToken(token)))
      .limit(1);
    if (!invitation) throw new WorkspaceServiceError("INVITATION_NOT_FOUND", 404);
    if (invitation.acceptedAt || invitation.revokedAt)
      throw new WorkspaceServiceError("INVITATION_NOT_FOUND", 404);
    if (invitation.expiresAt.getTime() < Date.now())
      throw new WorkspaceServiceError("INVITATION_EXPIRED", 410);
    if (invitation.email !== acceptingUser.email)
      throw new WorkspaceServiceError("INVITATION_EMAIL_MISMATCH", 403);
    const [existingMembership] = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, invitation.workspaceId),
          eq(workspaceMembers.userId, acceptingUser.userId),
        ),
      )
      .limit(1);
    if (!existingMembership)
      await tx.insert(workspaceMembers).values({
        workspaceId: invitation.workspaceId,
        userId: acceptingUser.userId,
        role: invitation.role,
      });
    await tx
      .update(workspaceInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(workspaceInvitations.id, invitation.id));
    await recordAuditEvent(tx, {
      workspaceId: invitation.workspaceId,
      actorUserId: acceptingUser.userId,
      action: "workspace_invitation.accepted",
      targetType: "workspace_invitation",
      targetId: invitation.id,
    });
    return { workspaceId: invitation.workspaceId };
  });
}
