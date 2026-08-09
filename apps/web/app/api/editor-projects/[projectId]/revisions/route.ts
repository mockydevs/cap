import { requireActor } from "../../../../../lib/auth/authorization";
import { editorError } from "../../../../../lib/editor/http";
import { listEditorRevisions } from "../../../../../lib/editor/service";
import { editorProjectParamsSchema } from "../../../../../lib/editor/validation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const actor = await requireActor(request, "MEMBER");
    const { projectId } = editorProjectParamsSchema.parse(await context.params);
    return Response.json(await listEditorRevisions(projectId, actor), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return editorError(error);
  }
}
