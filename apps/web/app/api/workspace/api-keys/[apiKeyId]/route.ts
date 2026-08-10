import { apiKeyError } from "../../../../../lib/api-keys/http";
import { revokeApiKey } from "../../../../../lib/api-keys/service";
import { apiKeyParamsSchema } from "../../../../../lib/api-keys/validation";
import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ apiKeyId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "ADMIN");
    const { apiKeyId } = apiKeyParamsSchema.parse(await context.params);
    await revokeApiKey(actor, apiKeyId);
    return Response.json({ status: "REVOKED" });
  } catch (error) {
    return apiKeyError(error);
  }
}
