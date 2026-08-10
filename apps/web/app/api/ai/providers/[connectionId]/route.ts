import { z } from "zod";
import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { aiError } from "../../../../../lib/ai/http";
import { revokeProviderConnection } from "../../../../../lib/ai/provider-connections";
export const runtime = "nodejs";
export async function DELETE(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const { connectionId } = await context.params;
    return Response.json(
      await revokeProviderConnection(
        await requireActor(request, "ADMIN"),
        z.string().uuid().parse(connectionId),
      ),
    );
  } catch (error) {
    return aiError(error);
  }
}
