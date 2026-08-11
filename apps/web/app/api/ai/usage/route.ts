import { requireActor } from "../../../../lib/auth/authorization";
import { aiError } from "../../../../lib/ai/http";
import { getMonthlyUsage } from "../../../../lib/ai/service";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    return Response.json(await getMonthlyUsage(await requireActor(request)), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return aiError(error);
  }
}
