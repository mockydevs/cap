import { requireActor } from "../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../lib/auth/origin";
import { aiError } from "../../../../lib/ai/http";
import { setProviderRoute } from "../../../../lib/ai/provider-connections";
import { providerRouteSchema } from "../../../../lib/ai/validation";
export const runtime = "nodejs";
export async function PUT(request: Request) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    return Response.json(
      await setProviderRoute(
        await requireActor(request, "ADMIN"),
        providerRouteSchema.parse(await request.json()),
      ),
    );
  } catch (error) {
    return aiError(error);
  }
}
