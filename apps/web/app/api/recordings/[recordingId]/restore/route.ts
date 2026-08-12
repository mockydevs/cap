import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { recordingError } from "../../../../../lib/recordings/http";
import { restoreRecording } from "../../../../../lib/recordings/service";
import { recordingParamsSchema } from "../../../../../lib/recordings/validation";

export const runtime = "nodejs";

export async function POST(
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
    await restoreRecording(actor, recordingId);
    return Response.json({ restored: true });
  } catch (error) {
    return recordingError(error);
  }
}
