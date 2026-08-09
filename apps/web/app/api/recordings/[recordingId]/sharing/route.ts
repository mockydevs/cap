import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { sharingError } from "../../../../../lib/sharing/http";
import { updateRecordingSharing } from "../../../../../lib/sharing/service";
import {
  recordingParamsSchema,
  updateSharingSchema,
} from "../../../../../lib/sharing/validation";

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
    const input = updateSharingSchema.parse(await request.json());
    return Response.json(
      await updateRecordingSharing(actor, recordingId, input),
    );
  } catch (error) {
    return sharingError(error);
  }
}
