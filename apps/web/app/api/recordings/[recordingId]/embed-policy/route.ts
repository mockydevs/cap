import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import {
  EmbedServiceError,
  updateEmbedPolicy,
} from "../../../../../lib/embeds/service";
import { embedPolicySchema } from "../../../../../lib/embeds/validation";
import { recordingParamsSchema } from "../../../../../lib/sharing/validation";
import { sharingError } from "../../../../../lib/sharing/http";

export const runtime = "nodejs";
export async function PUT(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "MEMBER");
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    const input = embedPolicySchema.parse(await request.json());
    return Response.json(await updateEmbedPolicy(actor, recordingId, input));
  } catch (error) {
    if (error instanceof EmbedServiceError)
      return Response.json(
        { error: { code: error.code } },
        { status: error.status },
      );
    return sharingError(error);
  }
}
