import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { users, workspaceMembers } from "../../../../db/schema";
import {
  hashPassword,
  loginSchema,
  verifyPassword,
} from "../../../../lib/auth/credentials";
import { hasTrustedOrigin, publicAppUrl } from "../../../../lib/auth/origin";
import {
  createSession,
  sessionCookieName,
  sessionCookieOptions,
} from "../../../../lib/auth/session";
import { clientAddress } from "../../../../lib/http/client-address";
import { enforceFixedWindowRateLimit } from "../../../../lib/sharing/rate-limit";

export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!hasTrustedOrigin(request))
    return Response.json(
      { error: { code: "INVALID_ORIGIN" } },
      { status: 403 },
    );
  try {
    const input = loginSchema.parse(
      Object.fromEntries(await request.formData()),
    );
    const limitKey = createHash("sha256")
      .update(`${clientAddress(request)}:${input.email}`)
      .digest("hex");
    await enforceFixedWindowRateLimit(`web-login:${limitKey}`, 10, 15 * 60);
    const [user] = await db()
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    // Equalize the expensive verification path to reduce account-enumeration timing signals.
    const passwordHash =
      user?.passwordHash ?? (await hashPassword("invalid-account-password"));
    const valid = await verifyPassword(passwordHash, input.password);
    if (!user || !valid) throw new Error("Invalid credentials");
    const [membership] = await db()
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, user.id))
      .limit(1);
    if (!membership) throw new Error("Account has no workspace");
    const token = await createSession(user.id, membership.workspaceId);
    const response = NextResponse.redirect(publicAppUrl("/record"), 303);
    response.cookies.set(sessionCookieName, token, sessionCookieOptions);
    return response;
  } catch {
    return NextResponse.redirect(publicAppUrl("/login?error=credentials"), 303);
  }
}
