import { requireActor } from "../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../lib/auth/origin";
import { aiError } from "../../../../lib/ai/http";
import { semanticSearch } from "../../../../lib/ai/service";
import { semanticSearchSchema } from "../../../../lib/ai/validation";
import { enforceFixedWindowRateLimit } from "../../../../lib/sharing/rate-limit";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const input = semanticSearchSchema.parse(await request.json());
    const actor = await requireActor(request);
    await enforceFixedWindowRateLimit(
      `ai-search:${actor.workspaceId}:${actor.userId}`,
      30,
      60,
    );
    return Response.json(
      {
        items: await semanticSearch(actor, input.query, input.limit),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return aiError(error);
  }
}
