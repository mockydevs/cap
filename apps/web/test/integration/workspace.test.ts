import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db/client";
import { users, workspaceMembers, workspaces } from "../../db/schema";
import { hashPassword } from "../../lib/auth/credentials";
import { findOrCreateGoogleUser, GoogleAccountConflictError } from "../../lib/auth/google";
import type { Actor } from "../../lib/auth/session";
import {
  inviteMember,
  listMembers,
  removeMember,
  updateMemberRole,
  WorkspaceServiceError,
} from "../../lib/workspace/service";

describe("Google account linking against a real database", () => {
  it("refuses to auto-link a Google identity to an existing password account", async () => {
    const email = `conflict-${randomUUID()}@example.com`;
    await db().insert(users).values({
      id: randomUUID(),
      email,
      passwordHash: await hashPassword("a genuinely random password value"),
      displayName: "Existing Password User",
    });
    await expect(
      findOrCreateGoogleUser({ subject: randomUUID(), email, displayName: "Attacker" }),
    ).rejects.toThrow(GoogleAccountConflictError);
  });

  it("creates a new user, workspace, and membership for a first-time Google sign-in", async () => {
    const email = `newuser-${randomUUID()}@example.com`;
    const account = await findOrCreateGoogleUser({
      subject: randomUUID(),
      email,
      displayName: "New Google User",
    });
    const [membership] = await db()
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, account.userId));
    expect(membership?.role).toBe("OWNER");
    expect(membership?.workspaceId).toBe(account.workspaceId);
  });
});

describe("workspace membership management against a real database", () => {
  let owner: Actor;
  let workspaceId: string;

  beforeAll(async () => {
    workspaceId = randomUUID();
    const ownerId = randomUUID();
    await db().insert(workspaces).values({ id: workspaceId, name: "Membership Test" });
    await db().insert(users).values({
      id: ownerId,
      email: `owner-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
      displayName: "Owner",
    });
    await db()
      .insert(workspaceMembers)
      .values({ workspaceId, userId: ownerId, role: "OWNER" });
    owner = { userId: ownerId, workspaceId, email: "owner@example.com", displayName: "Owner", role: "OWNER" };
  });

  it("adds an existing user directly and allows role changes and removal", async () => {
    const memberId = randomUUID();
    const memberEmail = `member-${randomUUID()}@example.com`;
    await db().insert(users).values({
      id: memberId,
      email: memberEmail,
      passwordHash: "not-a-real-hash",
      displayName: "Member",
    });

    const invited = await inviteMember(owner, { email: memberEmail, role: "MEMBER" });
    expect(invited).toEqual({ status: "ADDED", userId: memberId });

    const members = await listMembers(workspaceId);
    expect(members.map((m) => m.userId)).toContain(memberId);

    await updateMemberRole(owner, memberId, "ADMIN");
    const afterPromotion = await listMembers(workspaceId);
    expect(afterPromotion.find((m) => m.userId === memberId)?.role).toBe("ADMIN");

    await removeMember(owner, memberId);
    const afterRemoval = await listMembers(workspaceId);
    expect(afterRemoval.map((m) => m.userId)).not.toContain(memberId);
  });

  it("refuses to remove the last owner", async () => {
    await expect(removeMember(owner, owner.userId)).rejects.toThrow(
      WorkspaceServiceError,
    );
  });
});
