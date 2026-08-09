import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { requireActor } from "../../../../../lib/auth/authorization";
import { editorError } from "../../../../../lib/editor/http";
import { requestRender } from "../../../../../lib/editor/service";
import { editorProjectParamsSchema } from "../../../../../lib/editor/validation";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "MEMBER");
    const { projectId } = editorProjectParamsSchema.parse(await context.params);
    return Response.json(await requestRender(projectId, actor));
  } catch (error) {
    return editorError(error);
  }
}
