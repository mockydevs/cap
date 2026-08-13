import { requireActor } from "../../../../lib/auth/authorization";
import { aiError } from "../../../../lib/ai/http";
import { getEntitlements } from "../../../../lib/ai/service";
export const runtime = "nodejs";

/**
 * Which lane pays for each AI purpose, so the UI can say "connect a key or
 * start a plan" in place of a raw error code — and say it before the member
 * clicks rather than after.
 */
export async function GET(request: Request) {
  try {
    return Response.json(await getEntitlements(await requireActor(request)), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return aiError(error);
  }
}
