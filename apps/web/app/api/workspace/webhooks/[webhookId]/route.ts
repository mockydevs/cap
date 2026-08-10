import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { webhookError } from "../../../../../lib/webhooks/http";
import { deleteWebhookEndpoint } from "../../../../../lib/webhooks/service";
import { webhookParamsSchema } from "../../../../../lib/webhooks/validation";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ webhookId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "ADMIN");
    const { webhookId } = webhookParamsSchema.parse(await context.params);
    await deleteWebhookEndpoint(actor, webhookId);
    return Response.json({ status: "DELETED" });
  } catch (error) {
    return webhookError(error);
  }
}
