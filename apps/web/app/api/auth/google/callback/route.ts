import { NextResponse } from "next/server";
import {
  exchangeGoogleCode,
  findOrCreateGoogleUser,
  googleCookieNames,
  GoogleAccountConflictError,
} from "../../../../../lib/auth/google";
import { publicAppUrl } from "../../../../../lib/auth/origin";
import {
  createSession,
  sessionCookieName,
  sessionCookieOptions,
} from "../../../../../lib/auth/session";

export const runtime = "nodejs";

function cookie(request: Request, name: string) {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const expectedState = cookie(request, googleCookieNames.state);
    const verifier = cookie(request, googleCookieNames.verifier);
    const nonce = cookie(request, googleCookieNames.nonce);
    if (!code || !state || state !== expectedState || !verifier || !nonce)
      throw new Error("GOOGLE_STATE_MISMATCH");
    const identity = await exchangeGoogleCode({ code, verifier, nonce });
    const account = await findOrCreateGoogleUser(identity);
    const token = await createSession(account.userId, account.workspaceId);
    const response = NextResponse.redirect(publicAppUrl("/record"));
    response.cookies.set(sessionCookieName, token, sessionCookieOptions);
    for (const name of Object.values(googleCookieNames))
      response.cookies.set(name, "", { path: "/", maxAge: 0 });
    return response;
  } catch (error) {
    const errorCode =
      error instanceof GoogleAccountConflictError
        ? "google-account-exists"
        : "google";
    const response = NextResponse.redirect(
      publicAppUrl(`/login?error=${errorCode}`),
    );
    for (const name of Object.values(googleCookieNames))
      response.cookies.set(name, "", { path: "/", maxAge: 0 });
    return response;
  }
}
