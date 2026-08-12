import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { recordingError } from "../../../../../lib/recordings/http";
import { setRecordingStar } from "../../../../../lib/recordings/service";
import { recordingParamsSchema } from "../../../../../lib/recordings/validation";

export const runtime = "nodejs";

async function updateStar(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
  starred: boolean,
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request);
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    await setRecordingStar(actor, recordingId, starred);
    return Response.json({ starred });
  } catch (error) {
    return recordingError(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  return updateStar(request, context, true);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  return updateStar(request, context, false);
}
