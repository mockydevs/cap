import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@cap/domain";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../../db/client";
import { sessions, users, workspaceMembers } from "../../db/schema";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const sessionCookieName =
  process.env.NODE_ENV === "production" ? "__Host-cap_session" : "cap_session";
export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};
export const hashSessionToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export async function createSession(userId: string, workspaceId: string) {
  const token = randomBytes(32).toString("base64url");
  await db()
    .insert(sessions)
    .values({
      id: randomUUID(),
      tokenHash: hashSessionToken(token),
      userId,
      activeWorkspaceId: workspaceId,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    });
  return token;
}

export async function switchActiveWorkspace(
  token: string,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const [membership] = await db()
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!membership) return false;
  await db()
    .update(sessions)
    .set({ activeWorkspaceId: workspaceId })
    .where(
      and(eq(sessions.tokenHash, hashSessionToken(token)), eq(sessions.userId, userId)),
    );
  return true;
}

export async function revokeSession(token: string | undefined) {
  if (token)
    await db()
      .delete(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(token)));
}

export type Actor = {
  userId: string;
  workspaceId: string;
  email: string;
  displayName: string;
  role: WorkspaceRole;
};
export async function actorFromToken(
  token: string | undefined,
): Promise<Actor | null> {
  if (!token) return null;
  const [row] = await db()
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      workspaceId: sessions.activeWorkspaceId,
      role: workspaceMembers.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, sessions.userId),
        eq(workspaceMembers.workspaceId, sessions.activeWorkspaceId),
      ),
    )
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function tokenFromRequest(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const bearer = authorization.slice(7);
    if (/^[A-Za-z0-9_-]{43}$/.test(bearer)) return bearer;
  }
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${sessionCookieName}=`));
  return cookie
    ? decodeURIComponent(cookie.slice(sessionCookieName.length + 1))
    : undefined;
}

export function hasBearerSession(request: Request): boolean {
  return request.headers.get("authorization")?.startsWith("Bearer ") ?? false;
}
