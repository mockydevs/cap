import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { db } from "../../db/client";
import {
  oauthAccounts,
  users,
  workspaceMembers,
  workspaces,
} from "../../db/schema";
import { hashPassword } from "./credentials";

const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

export const googleCookieNames = {
  state:
    process.env.NODE_ENV === "production"
      ? "__Host-cap_google_state"
      : "cap_google_state",
  verifier:
    process.env.NODE_ENV === "production"
      ? "__Host-cap_google_verifier"
      : "cap_google_verifier",
  nonce:
    process.env.NODE_ENV === "production"
      ? "__Host-cap_google_nonce"
      : "cap_google_nonce",
};

export const googleCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 10 * 60,
};

function config() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!clientId || !clientSecret || !appUrl)
    throw new Error("GOOGLE_OAUTH_NOT_CONFIGURED");
  return {
    clientId,
    clientSecret,
    redirectUri: `${new URL(appUrl).origin}/api/auth/google/callback`,
  };
}

export function beginGoogleAuthorization() {
  const { clientId, redirectUri } = config();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { url, state, verifier, nonce };
}

type GoogleIdentity = {
  subject: string;
  email: string;
  displayName: string;
};

export async function exchangeGoogleCode(input: {
  code: string;
  verifier: string;
  nonce: string;
}): Promise<GoogleIdentity> {
  const { clientId, clientSecret, redirectUri } = config();
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: input.verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("GOOGLE_CODE_EXCHANGE_FAILED");
  const payload = (await response.json()) as { id_token?: string };
  if (!payload.id_token) throw new Error("GOOGLE_ID_TOKEN_MISSING");
  return verifyGoogleIdToken(payload.id_token, clientId, input.nonce);
}

export async function verifyGoogleIdToken(
  idToken: string,
  audience: string,
  nonce?: string,
): Promise<GoogleIdentity> {
  const verified = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience,
  });
  if (nonce && verified.payload.nonce !== nonce)
    throw new Error("GOOGLE_NONCE_MISMATCH");
  const email = verified.payload.email;
  if (
    typeof verified.payload.sub !== "string" ||
    typeof email !== "string" ||
    verified.payload.email_verified !== true
  )
    throw new Error("GOOGLE_IDENTITY_UNVERIFIED");
  return {
    subject: verified.payload.sub,
    email: email.trim().toLowerCase(),
    displayName:
      typeof verified.payload.name === "string"
        ? verified.payload.name.slice(0, 100)
        : email.split("@")[0]!.slice(0, 100),
  };
}

export async function findOrCreateGoogleUser(identity: GoogleIdentity) {
  const [linked] = await db()
    .select({ userId: oauthAccounts.userId })
    .from(oauthAccounts)
    .where(
      and(
        eq(oauthAccounts.provider, "google"),
        eq(oauthAccounts.providerSubject, identity.subject),
      ),
    )
    .limit(1);
  let userId = linked?.userId;
  if (!userId) {
    const [existing] = await db()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, identity.email))
      .limit(1);
    userId = existing?.id ?? randomUUID();
    const workspaceId = randomUUID();
    const passwordHash = existing
      ? undefined
      : await hashPassword(randomBytes(48).toString("base64url"));
    await db().transaction(async (transaction) => {
      if (passwordHash) {
        await transaction.insert(users).values({
          id: userId!,
          email: identity.email,
          passwordHash,
          displayName: identity.displayName,
        });
        await transaction.insert(workspaces).values({
          id: workspaceId,
          name: `${identity.displayName}'s workspace`.slice(0, 100),
        });
        await transaction.insert(workspaceMembers).values({
          userId: userId!,
          workspaceId,
          role: "OWNER",
        });
      }
      await transaction.insert(oauthAccounts).values({
        id: randomUUID(),
        userId: userId!,
        provider: "google",
        providerSubject: identity.subject,
        emailAtLink: identity.email,
      });
    });
  } else {
    await db()
      .update(oauthAccounts)
      .set({ lastLoginAt: new Date() })
      .where(
        and(
          eq(oauthAccounts.provider, "google"),
          eq(oauthAccounts.providerSubject, identity.subject),
        ),
      );
  }
  const [membership] = await db()
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);
  if (!membership) throw new Error("GOOGLE_USER_HAS_NO_WORKSPACE");
  return { userId, workspaceId: membership.workspaceId };
}
