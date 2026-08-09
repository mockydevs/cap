import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { users, workspaceMembers, workspaces } from "../../../../db/schema";
import { hashPassword, signupSchema } from "../../../../lib/auth/credentials";
import { hasTrustedOrigin } from "../../../../lib/auth/origin";
import {
  createSession,
  sessionCookieName,
  sessionCookieOptions,
} from "../../../../lib/auth/session";

export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!hasTrustedOrigin(request))
    return Response.json(
      { error: { code: "INVALID_ORIGIN" } },
      { status: 403 },
    );
  try {
    const form = await request.formData();
    const input = signupSchema.parse(Object.fromEntries(form));
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const passwordHash = await hashPassword(input.password);
    await db().transaction(async (transaction) => {
      await transaction.insert(users).values({
        id: userId,
        email: input.email,
        passwordHash,
        displayName: input.displayName,
      });
      await transaction
        .insert(workspaces)
        .values({ id: workspaceId, name: input.workspaceName });
      await transaction
        .insert(workspaceMembers)
        .values({ userId, workspaceId, role: "OWNER" });
    });
    const token = await createSession(userId, workspaceId);
    const response = NextResponse.redirect(new URL("/", request.url), 303);
    response.cookies.set(sessionCookieName, token, sessionCookieOptions);
    return response;
  } catch {
    return NextResponse.redirect(
      new URL("/signup?error=account", request.url),
      303,
    );
  }
}
