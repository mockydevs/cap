import {
  revokeSession,
  tokenFromRequest,
} from "../../../../../lib/auth/session";

export const runtime = "nodejs";
export async function POST(request: Request) {
  await revokeSession(tokenFromRequest(request));
  return new Response(null, { status: 204 });
}
