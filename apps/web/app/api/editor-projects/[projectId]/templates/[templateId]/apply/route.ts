import { requireActor } from "../../../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../../../lib/auth/origin";
import { editorError } from "../../../../../../../lib/editor/http";
import { applyTemplateToProject } from "../../../../../../../lib/editor/service";
import {
  applyTemplateSchema,
  editorProjectParamsSchema,
  templateParamsSchema,
} from "../../../../../../../lib/editor/validation";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; templateId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "MEMBER");
    const params = await context.params;
    const { projectId } = editorProjectParamsSchema.parse(params);
    const { templateId } = templateParamsSchema.parse(params);
    const { position } = applyTemplateSchema.parse(await request.json());
    return Response.json(
      await applyTemplateToProject(actor, projectId, templateId, position),
    );
  } catch (error) {
    return editorError(error);
  }
}
