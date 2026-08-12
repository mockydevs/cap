import { NextResponse } from "next/server";
import {
  beginGoogleAuthorization,
  googleCookieNames,
  googleCookieOptions,
} from "../../../../lib/auth/google";
import { publicAppUrl } from "../../../../lib/auth/origin";

export const runtime = "nodejs";
export async function GET() {
  try {
    const authorization = beginGoogleAuthorization();
    const response = NextResponse.redirect(authorization.url, 302);
    response.cookies.set(
      googleCookieNames.state,
      authorization.state,
      googleCookieOptions,
    );
    response.cookies.set(
      googleCookieNames.verifier,
      authorization.verifier,
      googleCookieOptions,
    );
    response.cookies.set(
      googleCookieNames.nonce,
      authorization.nonce,
      googleCookieOptions,
    );
    return response;
  } catch {
    return NextResponse.redirect(publicAppUrl("/login?error=google"));
  }
}
