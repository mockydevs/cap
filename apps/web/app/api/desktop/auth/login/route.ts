import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../../../../db/client";
import { users, workspaceMembers } from "../../../../../db/schema";
import {
  hashPassword,
  loginSchema,
  verifyPassword,
} from "../../../../../lib/auth/credentials";
import { createSession } from "../../../../../lib/auth/session";
import { clientAddress } from "../../../../../lib/http/client-address";
import { enforceFixedWindowRateLimit } from "../../../../../lib/sharing/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      return Response.json(
        { error: { code: "INVALID_CONTENT_TYPE" } },
        { status: 415 },
      );
    const input = loginSchema.parse(await request.json());
    const limitKey = createHash("sha256")
      .update(`${clientAddress(request)}:${input.email}`)
      .digest("hex");
    await enforceFixedWindowRateLimit(`desktop-login:${limitKey}`, 10, 15 * 60);
    const [user] = await db()
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    const passwordHash =
      user?.passwordHash ?? (await hashPassword("invalid-account-password"));
    const valid = await verifyPassword(passwordHash, input.password);
    if (!user || !valid)
      return Response.json(
        { error: { code: "INVALID_CREDENTIALS" } },
        { status: 401 },
      );
    const [membership] = await db()
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, user.id))
      .limit(1);
    if (!membership)
      return Response.json(
        { error: { code: "NO_WORKSPACE" } },
        { status: 403 },
      );
    const token = await createSession(user.id, membership.workspaceId);
    return Response.json(
      {
        token,
        expiresInSeconds: 60 * 60 * 24 * 30,
        user: { id: user.id, email: user.email, displayName: user.displayName },
        workspace: { id: membership.workspaceId, role: membership.role },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: { code: "INVALID_CREDENTIALS" } },
      { status: 401 },
    );
  }
}
