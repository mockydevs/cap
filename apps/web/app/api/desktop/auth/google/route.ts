import { createHash } from "node:crypto";
import { z } from "zod";
import {
  findOrCreateGoogleUser,
  verifyGoogleIdToken,
} from "../../../../../lib/auth/google";
import { createSession } from "../../../../../lib/auth/session";
import { clientAddress } from "../../../../../lib/http/client-address";
import { enforceFixedWindowRateLimit } from "../../../../../lib/sharing/rate-limit";

export const runtime = "nodejs";
const inputSchema = z.object({
  idToken: z.string().min(100).max(10_000),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export async function POST(request: Request) {
  try {
    const clientId = process.env.GOOGLE_DESKTOP_OAUTH_CLIENT_ID;
    if (!clientId) throw new Error("GOOGLE_DESKTOP_OAUTH_NOT_CONFIGURED");
    await enforceFixedWindowRateLimit(
      `desktop-google:${createHash("sha256").update(clientAddress(request)).digest("hex")}`,
      20,
      15 * 60,
    );
    const input = inputSchema.parse(await request.json());
    const identity = await verifyGoogleIdToken(
      input.idToken,
      clientId,
      input.nonce,
    );
    const account = await findOrCreateGoogleUser(identity);
    const token = await createSession(account.userId, account.workspaceId);
    return Response.json(
      { token, displayName: identity.displayName },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: { code: "GOOGLE_AUTHENTICATION_FAILED" } },
      { status: 401 },
    );
  }
}
