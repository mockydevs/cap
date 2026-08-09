import { requireActor } from "../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../lib/auth/origin";
import { aiError } from "../../../../lib/ai/http";
import { getPolicy, setPolicy } from "../../../../lib/ai/service";
import { aiPolicySchema } from "../../../../lib/ai/validation";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    return Response.json(await getPolicy(await requireActor(request)), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return aiError(error);
  }
}
export async function PUT(request: Request) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    return Response.json(
      await setPolicy(
        await requireActor(request, "ADMIN"),
        aiPolicySchema.parse(await request.json()),
      ),
    );
  } catch (error) {
    return aiError(error);
  }
}
