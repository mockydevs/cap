import { requireActor } from "../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../lib/auth/origin";
import { webhookError } from "../../../../lib/webhooks/http";
import {
  createWebhookEndpoint,
  listWebhookEndpoints,
} from "../../../../lib/webhooks/service";
import { createWebhookEndpointSchema } from "../../../../lib/webhooks/validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "ADMIN");
    const items = await listWebhookEndpoints(actor.workspaceId);
    return Response.json({
      items: items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        lastDeliveryAt: item.lastDeliveryAt?.toISOString() ?? null,
      })),
    });
  } catch (error) {
    return webhookError(error);
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
    const input = createWebhookEndpointSchema.parse(await request.json());
    const result = await createWebhookEndpoint(actor, input);
    return Response.json(result, { status: 201 });
  } catch (error) {
    return webhookError(error);
  }
}
