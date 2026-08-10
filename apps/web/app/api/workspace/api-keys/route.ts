import { createApiKey, listApiKeys } from "../../../../lib/api-keys/service";
import { createApiKeySchema } from "../../../../lib/api-keys/validation";
import { apiKeyError } from "../../../../lib/api-keys/http";
import { requireActor } from "../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../lib/auth/origin";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "ADMIN");
    const items = await listApiKeys(actor.workspaceId);
    return Response.json({
      items: items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        lastUsedAt: item.lastUsedAt?.toISOString() ?? null,
        revokedAt: item.revokedAt?.toISOString() ?? null,
      })),
    });
  } catch (error) {
    return apiKeyError(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "ADMIN");
    const { name } = createApiKeySchema.parse(await request.json());
    const result = await createApiKey(actor, name);
    return Response.json(result, { status: 201 });
  } catch (error) {
    return apiKeyError(error);
  }
}
