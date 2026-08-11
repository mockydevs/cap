import { z } from "zod";
import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { aiError } from "../../../../../lib/ai/http";
import {
  revokeProviderConnection,
  rotateProviderConnection,
} from "../../../../../lib/ai/provider-connections";
import { rotateProviderConnectionSchema } from "../../../../../lib/ai/validation";
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
/** Replaces an existing connection's API key without the create-new/
 * revoke-old round trip a full rotation otherwise requires. */
export async function PATCH(
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
    const input = rotateProviderConnectionSchema.parse(await request.json());
    return Response.json(
      await rotateProviderConnection(
        await requireActor(request, "ADMIN"),
        z.string().uuid().parse(connectionId),
        input.apiKey,
      ),
    );
  } catch (error) {
    return aiError(error);
  }
}
