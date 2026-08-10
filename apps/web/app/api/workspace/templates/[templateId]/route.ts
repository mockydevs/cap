import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { editorError } from "../../../../../lib/editor/http";
import { deleteTemplate } from "../../../../../lib/editor/service";
import { templateParamsSchema } from "../../../../../lib/editor/validation";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "ADMIN");
    const { templateId } = templateParamsSchema.parse(await context.params);
    await deleteTemplate(actor, templateId);
    return Response.json({ status: "DELETED" });
  } catch (error) {
    return editorError(error);
  }
}
