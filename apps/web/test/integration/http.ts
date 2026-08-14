import { randomUUID } from "node:crypto";
import { db } from "../../db/client";
import { users, workspaceMembers, workspaces } from "../../db/schema";
import { hashPassword } from "../../lib/auth/credentials";
import {
  createSession,
  sessionCookieName,
  type Actor,
} from "../../lib/auth/session";

/**
 * Calls route handlers the way a browser does.
 *
 * The unit suite covers services directly, which is why a bug could ship where
 * the read endpoint returned a shape the write endpoint's schema rejected:
 * both halves were individually correct and nothing exercised the round trip.
 * These helpers drive the exported handlers with a real session cookie and a
 * real origin, against a real database.
 */

const APP_URL = "http://localhost:3000";

export interface SignedInActor {
  readonly actor: Actor;
  readonly cookie: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly email: string;
}

export async function signIn(
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" = "OWNER",
): Promise<SignedInActor> {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const email = `route-${userId}@example.com`;
  await db().transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email,
      passwordHash: await hashPassword("a genuinely random password value"),
      displayName: "Route Test User",
    });
    await tx.insert(workspaces).values({ id: workspaceId, name: "Route Test" });
    await tx.insert(workspaceMembers).values({ userId, workspaceId, role });
  });
  const token = await createSession(userId, workspaceId);
  return {
    actor: {
      userId,
      workspaceId,
      email,
      displayName: "Route Test User",
      role,
    },
    cookie: `${sessionCookieName}=${token}`,
    userId,
    workspaceId,
    email,
  };
}

/** Parsed JSON, indexable so tests can assert on nested response fields. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonValue = any;

export type RouteHandler<Params extends Record<string, string>> = (
  request: Request,
  context: { params: Promise<Params> },
) => Promise<Response>;

/**
 * Origin is always sent: every mutating route checks it, and omitting it here
 * would make these tests pass for a reason browsers never reproduce.
 */
export async function call<
  Params extends Record<string, string> = Record<string, string>,
>(
  handler: RouteHandler<Params>,
  options: {
    readonly method?: string;
    readonly path?: string;
    readonly session?: SignedInActor | undefined;
    readonly body?: unknown;
    readonly params?: Params;
  } = {},
): Promise<{ status: number; body: JsonValue }> {
  const method = options.method ?? "GET";
  const headers = new Headers({ origin: APP_URL });
  if (options.session) headers.set("cookie", options.session.cookie);
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  const response = await handler(
    new Request(`${APP_URL}${options.path ?? "/"}`, {
      method,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    }),
    { params: Promise.resolve((options.params ?? {}) as Params) },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
  };
}
