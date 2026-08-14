import { requireActor } from "../../../../../lib/auth/authorization";
import { recordingError } from "../../../../../lib/recordings/http";
import { recordingPreview } from "../../../../../lib/recordings/preview";
import { recordingParamsSchema } from "../../../../../lib/sharing/validation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const actor = await requireActor(request);
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    const preview = await recordingPreview(actor, recordingId);
    if (!preview)
      return Response.json(
        { error: { code: "PREVIEW_NOT_READY" } },
        { status: 409, headers: { "cache-control": "private, no-store" } },
      );
    return Response.json(preview, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return recordingError(error);
  }
}
