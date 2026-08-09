import { NextResponse } from "next/server";
import { hasTrustedOrigin } from "../../../../lib/auth/origin";
import {
  revokeSession,
  sessionCookieName,
  sessionCookieOptions,
  tokenFromRequest,
} from "../../../../lib/auth/session";

export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!hasTrustedOrigin(request))
    return Response.json(
      { error: { code: "INVALID_ORIGIN" } },
      { status: 403 },
    );
  await revokeSession(tokenFromRequest(request));
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  response.cookies.set(sessionCookieName, "", {
    ...sessionCookieOptions,
    maxAge: 0,
  });
  return response;
}
