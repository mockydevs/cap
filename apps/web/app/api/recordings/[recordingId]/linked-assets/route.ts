import { requireActor } from "../../../../../lib/auth/authorization";
import { editorError } from "../../../../../lib/editor/http";
import { listLinkedRecordingAssets } from "../../../../../lib/editor/service";
import { recordingParamsSchema } from "../../../../../lib/sharing/validation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const actor = await requireActor(request, "MEMBER");
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    const items = await listLinkedRecordingAssets(recordingId, actor);
    return Response.json({ items });
  } catch (error) {
    return editorError(error);
  }
}
