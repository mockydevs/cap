import { requireActor } from "../../../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../../../lib/auth/origin";
import { recordingParamsSchema } from "../../../../../../../lib/sharing/validation";
import { transcriptError } from "../../../../../../../lib/transcripts/http";
import { updateTranscriptSegment } from "../../../../../../../lib/transcripts/service";
import { transcriptSegmentUpdateSchema } from "../../../../../../../lib/transcripts/validation";
import { z } from "zod";

const paramsSchema = recordingParamsSchema.extend({
  segmentId: z.string().uuid(),
});
export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ recordingId: string; segmentId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "MEMBER");
    const { recordingId, segmentId } = paramsSchema.parse(await context.params);
    const input = transcriptSegmentUpdateSchema.parse(await request.json());
    return Response.json(
      await updateTranscriptSegment(recordingId, segmentId, actor, input),
    );
  } catch (error) {
    return transcriptError(error);
  }
}
