import { requireActor } from "../../../../../../../lib/auth/authorization";
import { editorError } from "../../../../../../../lib/editor/http";
import {
  loadRender,
  renderDownload,
} from "../../../../../../../lib/editor/service";
import {
  editorProjectParamsSchema,
  renderParamsSchema,
} from "../../../../../../../lib/editor/validation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; renderJobId: string }> },
) {
  try {
    const actor = await requireActor(request, "MEMBER");
    const { projectId } = editorProjectParamsSchema.parse(await context.params);
    const { renderJobId } = renderParamsSchema.parse(await context.params);
    const render = await loadRender(renderJobId, actor);
    if (render.projectId !== projectId)
      return Response.json(
        { error: { code: "RENDER_NOT_FOUND" } },
        { status: 404 },
      );
    return Response.json(await renderDownload(renderJobId, actor), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return editorError(error);
  }
}
