import { requireActor } from "../../../../../lib/auth/authorization";
import { recordingEngagement } from "../../../../../lib/analytics/service";
import { recordingError } from "../../../../../lib/recordings/http";
import { recordingParamsSchema } from "../../../../../lib/recordings/validation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const actor = await requireActor(request, "MEMBER");
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    return Response.json(await recordingEngagement(actor, recordingId));
  } catch (error) {
    return recordingError(error);
  }
}
