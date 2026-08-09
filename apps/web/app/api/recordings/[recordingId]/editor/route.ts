import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { requireActor } from "../../../../../lib/auth/authorization";
import { editorError } from "../../../../../lib/editor/http";
import { loadEditor, saveEditor } from "../../../../../lib/editor/service";
import { editorSaveSchema } from "../../../../../lib/editor/validation";
import { recordingParamsSchema } from "../../../../../lib/sharing/validation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const actor = await requireActor(request, "MEMBER");
    const { recordingId } = recordingParamsSchema.parse(await context.params);
    return Response.json(await loadEditor(recordingId, actor), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return editorError(error);
  }
}

export async function PATCH(
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
    const input = editorSaveSchema.parse(await request.json());
    if (input.document.recordingId !== recordingId)
      return Response.json(
        { error: { code: "EDITOR_RECORDING_MISMATCH" } },
        { status: 400 },
      );
    return Response.json(
      await saveEditor(
        input.projectId,
        actor,
        input.expectedRevision,
        input.document,
      ),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return editorError(error);
  }
}
