import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { aiError } from "../../../../../lib/ai/http";
import { validateProviderCredential } from "../../../../../lib/ai/provider-connections";
import { providerModelsLookupSchema } from "../../../../../lib/ai/validation";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    await requireActor(request, "ADMIN");
    return Response.json(
      await validateProviderCredential(
        providerModelsLookupSchema.parse(await request.json()),
      ),
    );
  } catch (error) {
    return aiError(error);
  }
}
